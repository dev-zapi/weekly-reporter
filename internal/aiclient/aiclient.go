// Package aiclient 是 AI 适配层的骨架：把一行 ai_config 变成一次「结构化一次性
// 输出」调用，即 Vercel AI SDK `generateObject` + zod 的 Go 对应物。
//
// B5（本票）只需 one-shot 路径：三个 `ai/*` 路由各发一次非流式请求，要求模型返回
// 一个符合 JSON Schema 的对象。ADR-0027 定型的 stepRequest / stepResult / runStep
// 流式 adapter 面（step 级事件归一化、tool-loop、reasoning 字段、items 回放开关）
// 属于 B6 的范围，这里刻意不预实现。
//
// 协议选择照 src/lib/ai/provider.ts 的 createModelFromConfig：
//   - "anthropic"         → Anthropic Messages API
//   - "openai-compatible" → OpenAI Chat Completions（兼容代理）
//   - 其它（含 "openai"） → OpenAI Responses API
//
// 只移植 one-shot 需要的传输细节；响应体解析见各协议的 generate* 方法。
//
// 传输语义：postJSON 复刻 AI SDK 的默认重试（`maxRetries=2`，初始 2s、指数退避
// ×2，尊重 Retry-After，仅对 408/409/429/5xx 与网络错误重试）；baseURL 的尾斜杠
// 处理与 SDK 的 withoutTrailingSlash 同一语义（只去一个）。
package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// 协议常量与 ai_config.protocol 的取值一致。
const (
	ProtocolAnthropic        = "anthropic"
	ProtocolOpenAI           = "openai"
	ProtocolOpenAICompatible = "openai-compatible"
)

// 官方端点的默认 base URL。provider.ts 里 baseURL 为假值时不传，SDK 各自兜底到
// 这两个地址（openai 的 base 自带 /v1，anthropic 的带 /v1 之后才拼 /messages）。
const (
	defaultOpenAIBaseURL    = "https://api.openai.com/v1"
	defaultAnthropicBaseURL = "https://api.anthropic.com/v1"
	// anthropicPublicAPIURL 是 @ai-sdk/anthropic 里被特殊处理的那个裸域名。
	anthropicPublicAPIURL = "https://api.anthropic.com"
)

// Config 是 ai_config 行里一次性调用需要的四列。
type Config struct {
	Protocol string
	BaseURL  string
	APIKey   string
	Model    string
}

// Client 是一个绑定到单行 ai_config 的传输客户端。
//
// 不做连接池/超时策略：one-shot 直接吃请求 ctx，取消（客户端断连）由调用方传导。
// provider 端点由 ai_config.api_url 决定，httptest 的 mock provider 因此不需要
// 额外注入点。
type Client struct {
	cfg Config
}

// New 包一个 ai_config 行。
func New(cfg Config) *Client { return &Client{cfg: cfg} }

// ObjectRequest 是一次结构化输出的请求参数。
//
//   - Prompt：整段用户提示词（现有 ai.ts 把风格 systemPrompt 拼进 prompt 里，
//     不再单独发 system 消息，这里保持一致）。
//   - Temperature：来自风格配置；NaN 表示「该行温度解析失败」，按 JS 的
//     JSON.stringify(NaN) 语义序列化成 null。
//   - Schema：JSON Schema（zod schema 的 draft-07 输出）。
type ObjectRequest struct {
	Prompt      string
	Temperature float64
	Schema      json.RawMessage
}

// GenerateObject 发一次结构化输出请求，返回模型给出的对象 JSON 文本。
//
// 返回值是「模型输出里的那一段 JSON」，不做校验：必填键与类型断言属于各调用方
// 的 zod schema 对应物（见 internal/api/ai/schema.go）。
func (c *Client) GenerateObject(ctx context.Context, req ObjectRequest) (string, error) {
	switch c.cfg.Protocol {
	case ProtocolAnthropic:
		return c.generateAnthropic(ctx, req)
	case ProtocolOpenAICompatible:
		return c.generateChatCompletions(ctx, req)
	default:
		// provider.ts 的写法是「非 anthropic 全走 createOpenAI，非
		// openai-compatible 就取默认 Responses API」，未知 protocol 字符串因此也
		// 落到 Responses。
		return c.generateResponses(ctx, req)
	}
}

// StatusError 是 provider 返回非 2xx 时的错误。信息只进 500 响应的 details
// 诊断字段（route.ts 的 String(error)），不构成契约。
type StatusError struct {
	StatusCode int
	Body       string
	// RetryAfter 是响应头 retry-after-ms / retry-after 给出的等待时长。
	// RetryAfterSet 区分「响应头明确给 0」与「未给」。
	RetryAfter    time.Duration
	RetryAfterSet bool
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("provider responded %d: %s", e.StatusCode, e.Body)
}

// ErrNoObject 表示 2xx 响应里没有可用的对象文本（协议层异常，例如模型拒答）。
var ErrNoObject = errors.New("provider response carried no object")

// AI SDK 的重试默认值（prepareRetries / retryWithExponentialBackoffRespectingRetryHeaders）：
// maxRetries=2 表示最多再试两次（共 3 次），初始延迟 2s，指数退避 ×2。
const (
	maxRetries             = 2
	initialRetryDelay      = 2000 * time.Millisecond
	retryBackoffMultiplier = 2
)

// retryableStatus 复刻 APICallError.isRetryable 的默认判定：
// 408（超时）、409（冲突）、429（限流）与 5xx 才重试。
func retryableStatus(code int) bool {
	return code == http.StatusRequestTimeout ||
		code == http.StatusConflict ||
		code == http.StatusTooManyRequests ||
		code >= 500
}

// postJSON 发一个 JSON POST 并返回响应体。
//
// 重试语义照 AI SDK 的 generateObject：对可重试状态码（408/409/429/5xx）与网络
// 错误最多重试 maxRetries 次，指数退避并尊重 Retry-After(-ms)；请求 ctx 取消 /
// 超时立即放弃（对应 SDK 的 abort 不重试）。耗尽后返回 "Failed after N attempts"
// 的包装错误——文案只进 500 响应的 details，不构成契约。
func (c *Client) postJSON(ctx context.Context, url string, body any, headers map[string]string) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	delay := initialRetryDelay
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			if err := sleepContext(ctx, retryDelay(lastErr, delay)); err != nil {
				return nil, err
			}
			delay *= retryBackoffMultiplier
		}

		raw, err := c.doJSON(ctx, url, payload, headers)
		if err == nil {
			return raw, nil
		}
		lastErr = err
		if !isRetryable(ctx, err) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("Failed after %d attempts. Last error: %w", maxRetries+1, lastErr)
}

// errInvalidRequest 是构造请求时的错误（URL 不合法等）。SDK 的 fetch 对这类输入
// 抛的 TypeError 不在「网络错误」清单里，因此不重试；这里用哨兵值保持同样语义。
var errInvalidRequest = errors.New("invalid request")

// doJSON 发一次请求（不含重试）。
func (c *Client) doJSON(ctx context.Context, url string, payload []byte, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errInvalidRequest, err)
	}
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	// provider.ts 的 withTraceHeaders：出站调用带 traceparent + x-trace-id。
	if tc, ok := trace.FromContext(ctx); ok {
		req.Header.Set("traceparent", trace.TraceParent(tc.TraceID, tc.SpanID))
		req.Header.Set("x-trace-id", tc.TraceID)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		retryAfter, hasRetryAfter := parseRetryAfter(res.Header)
		return nil, &StatusError{
			StatusCode:    res.StatusCode,
			Body:          string(raw),
			RetryAfter:    retryAfter,
			RetryAfterSet: hasRetryAfter,
		}
	}
	return raw, nil
}

// isRetryable 对应 SDK 的 shouldRetry：APICallError 的 isRetryable（状态码）或
// 网络错误（fetch 失败被包成 isRetryable: true 的 APICallError）。请求 ctx 的
// 取消/超时不重试（SDK 对 abort 直接抛出）。
func isRetryable(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	// 请求构造失败（URL 不合法等）：SDK 对这类 TypeError 不重试。
	if errors.Is(err, errInvalidRequest) {
		return false
	}
	var statusError *StatusError
	if errors.As(err, &statusError) {
		return retryableStatus(statusError.StatusCode)
	}
	// 其余传输层失败（连接被拒、DNS、读 body 中断）：SDK 对网络错误重试。
	return true
}

// retryDelay 复刻 retryWithExponentialBackoffRespectingRetryHeaders 的
// getRetryDelayInMs：响应头给出可接受的等待时长时优先用它，否则退回指数退避。
// 可接受 = 0 <= ms < 60s，或 ms < 指数退避值（SDK 的同一条件）。
func retryDelay(err error, exponentialDelay time.Duration) time.Duration {
	var statusError *StatusError
	if !errors.As(err, &statusError) || !statusError.RetryAfterSet {
		return exponentialDelay
	}
	ms := statusError.RetryAfter
	if ms >= 0 && (ms < 60*time.Second || ms < exponentialDelay) {
		return ms
	}
	return exponentialDelay
}

// parseRetryAfter 读 retry-after-ms / retry-after（秒或 HTTP 日期）。
func parseRetryAfter(headers http.Header) (time.Duration, bool) {
	if value := headers.Get("retry-after-ms"); value != "" {
		if ms, err := strconv.ParseFloat(value, 64); err == nil && !math.IsNaN(ms) {
			return time.Duration(ms * float64(time.Millisecond)), true
		}
	}
	if value := headers.Get("retry-after"); value != "" {
		if seconds, err := strconv.ParseFloat(value, 64); err == nil && !math.IsNaN(seconds) {
			return time.Duration(seconds * float64(time.Second)), true
		}
		if when, err := http.ParseTime(value); err == nil {
			return time.Until(when), true
		}
	}
	return 0, false
}

// sleepContext 在等待期间响应 ctx 取消（对应 SDK delay 的 abortSignal）。
func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// errInvalidBaseURL 对应 SDK 的 validateBaseURL 抛 InvalidArgumentError：纯空白
// 的 baseURL 在发请求前就报错（api_url 经 PUT /api/settings/ai 校验后不会落库成
// 该形态，这里只是保持与 SDK 相同的兜底形状）。
var errInvalidBaseURL = errors.New("baseURL must be a non-empty string.")

// baseURL 复刻 provider.ts 的 withoutTrailingSlash 处理：SDK 的
// `url.replace(/\/$/, "")` 只去掉**一个**尾斜杠（不是全部），所以 "https://x/v1//"
// 保留一个斜杠——与 TS 的 one-shot 请求路径一致（".../v1//responses"）。
//
// 空串回落到 SDK 的默认端点（provider.ts 对 anthropic 传 `config.apiUrl ||
// undefined`，两个 provider 未配置时都取各自默认值）。
func (c *Client) baseURL(fallback string) (string, error) {
	base := strings.TrimSuffix(c.cfg.BaseURL, "/")
	if base == "" {
		return fallback, nil
	}
	if strings.TrimSpace(base) == "" {
		return "", errInvalidBaseURL
	}
	return base, nil
}

// anthropicBaseURL 复刻 @ai-sdk/anthropic 的 normalizeBaseURL：未配置 baseURL
// 时用默认值；配置的恰好是 `https://api.anthropic.com`（无 /v1）时补上 /v1，
// 其余自定义地址原样使用（兼容代理要的就是它自己那一段路径）。
func (c *Client) anthropicBaseURL() (string, error) {
	base, err := c.baseURL(defaultAnthropicBaseURL)
	if err != nil {
		return "", err
	}
	if base == anthropicPublicAPIURL {
		return anthropicPublicAPIURL + "/v1", nil
	}
	return base, nil
}

// setTemperature 写温度。NaN 按 JSON.stringify 语义写成 null。
func setTemperature(body map[string]any, temperature float64) {
	if math.IsNaN(temperature) {
		body["temperature"] = nil
		return
	}
	body["temperature"] = temperature
}
