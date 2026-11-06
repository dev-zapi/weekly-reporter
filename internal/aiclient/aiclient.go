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
	"strings"

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
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("provider responded %d: %s", e.StatusCode, e.Body)
}

// ErrNoObject 表示 2xx 响应里没有可用的对象文本（协议层异常，例如模型拒答）。
var ErrNoObject = errors.New("provider response carried no object")

// postJSON 发一个 JSON POST 并返回响应体。
func (c *Client) postJSON(ctx context.Context, url string, body any, headers map[string]string) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
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
		return nil, &StatusError{StatusCode: res.StatusCode, Body: string(raw)}
	}
	return raw, nil
}

// baseURL 复刻 provider.ts 的 withoutTrailingSlash 处理。
func (c *Client) baseURL(fallback string) string {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	if base == "" {
		return fallback
	}
	return base
}

// anthropicBaseURL 复刻 @ai-sdk/anthropic 的 normalizeBaseURL：未配置 baseURL
// 时用默认值；配置的恰好是 `https://api.anthropic.com`（无 /v1）时补上 /v1，
// 其余自定义地址原样使用（兼容代理要的就是它自己那一段路径）。
func (c *Client) anthropicBaseURL() string {
	base := c.baseURL(defaultAnthropicBaseURL)
	if base == anthropicPublicAPIURL {
		return anthropicPublicAPIURL + "/v1"
	}
	return base
}

// setTemperature 写温度。NaN 按 JSON.stringify 语义写成 null。
func setTemperature(body map[string]any, temperature float64) {
	if math.IsNaN(temperature) {
		body["temperature"] = nil
		return
	}
	body["temperature"] = temperature
}
