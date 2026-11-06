package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// 本文件移植 src/lib/ai/provider.ts 的两个探测函数：
//
//   - fetchModelList：GET {apiUrl 去掉尾斜杠}/models，Authorization Bearer，
//     10s 超时；非 2xx 抛 Error(`Failed to fetch models: {status} {statusText}`)。
//   - testConnection：按协议发一次最小生成请求（prompt 'Hi'、maxOutputTokens 5），
//     成功即 {ok:true}，失败把错误消息放进 {ok:false, error}。
//
// provider.ts 的 testConnection 走 AI SDK 的 createModelFromConfig + generateText。
// 票面允许本批先用 Go 标准库直连（B6 的 internal/aiclient adapter 落地后只换
// 接线，不改变本包的 HTTP 契约）。因此这里复刻的是**可观测结果**：
//
//   - 请求走同一组端点（anthropic /messages、openai /responses、
//     openai-compatible /chat/completions）与认证头；
//   - 非 2xx 时错误消息取 provider 错误体的 error.message（SDK 的
//     createJsonErrorResponseHandler 语义），取不到时用 statusText；
//   - 2xx 但响应体不可解析/缺必要字段时用 SDK 的 "Failed to process successful
//     response"；
//   - 网络失败用 "Cannot connect to API: ..." 前缀（SDK handleFetchError 语义，
//     细节文本是 Go 的传输层错误，不驱动契约）。
//
// 有意收窄：AI SDK 的 maxRetries=2 指数退避没有复刻——探测只看最终的
// {ok, error}，重试次数不影响响应形状，且会在连通性测试里把失败放大成三次
// 请求；真实重试策略归 B6 adapter。同理，SDK 按模型 id 做的参数改写
// （reasoning model 把 max_tokens 换成 max_completion_tokens、去掉 temperature）
// 没有复刻：探测请求里不含 temperature，剩余差异只在请求体参数名上，不改变
// 本路由的响应契约。响应体校验也没有逐字段复刻 zod schema（只校验该协议的
// 顶层容器：content / choices / output），所以「2xx + 形状畸形的响应体」这一档
// 可能比 TS 更宽松；provider 的正常响应与错误响应都是逐字节对齐的。

// providerConfig 是探测需要的配置投影。
type providerConfig struct {
	Protocol string
	APIURL   string
	APIKey   string
	Model    string
}

// defaultAnthropicBaseURL 是 SDK 的默认 baseURL（带 /v1）。
const defaultAnthropicBaseURL = "https://api.anthropic.com/v1"

// anthropicBaseURL 复刻 @ai-sdk/anthropic 的 normalizeBaseURL + 默认值：
// 校验非空白 → 去掉一个尾斜杠；等于裸的 https://api.anthropic.com 时补 /v1。
// provider.ts 传的是 `config.apiUrl || undefined`，所以空串回落到环境变量，
// 再回落到默认值。
func anthropicBaseURL(apiURL string) (string, error) {
	base := apiURL
	if base == "" {
		base = os.Getenv("ANTHROPIC_BASE_URL")
	}
	if strings.TrimSpace(base) == "" {
		if base == "" {
			return defaultAnthropicBaseURL, nil
		}
		return "", errors.New("baseURL must be a non-empty string.")
	}
	base = trimOneTrailingSlash(base)
	if base == "https://api.anthropic.com" {
		return base + "/v1", nil
	}
	return base, nil
}

// trimOneTrailingSlash 复刻 SDK 的 withoutTrailingSlash（只去掉一个 '/'）。
func trimOneTrailingSlash(value string) string {
	return strings.TrimSuffix(value, "/")
}

// probeBaseURL 复刻 createOpenAI 的 `withoutTrailingSlash(validateBaseURL(...))`：
// baseURL 去掉一个尾斜杠；空串（含纯空白）抛 InvalidArgumentError。
func probeBaseURL(apiURL string) (string, error) {
	base := trimOneTrailingSlash(apiURL)
	if strings.TrimSpace(base) == "" {
		return "", errors.New("baseURL must be a non-empty string.")
	}
	return base, nil
}

// applyTraceHeaders 复刻 provider.ts 的 withTraceHeaders：把当前请求的
// traceparent / x-trace-id 覆盖到出站请求上。
func applyTraceHeaders(ctx context.Context, req *http.Request) {
	tc, ok := trace.FromContext(ctx)
	if !ok {
		return
	}
	req.Header.Set("traceparent", trace.TraceParent(tc.TraceID, tc.SpanID))
	req.Header.Set("x-trace-id", tc.TraceID)
}

// fetchModelList 复刻 provider.ts 的 fetchModelList。
func fetchModelList(ctx context.Context, do func(*http.Request) (*http.Response, error), cfg providerConfig) ([]any, error) {
	if cfg.Protocol == "anthropic" {
		return []any{}, nil
	}

	target := trimTrailingSlashes(cfg.APIURL) + "/models"
	if !isValidFetchURL(target) {
		return nil, fmt.Errorf("Failed to parse URL from %s", target)
	}

	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("Failed to parse URL from %s", target)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	applyTraceHeaders(ctx, req)

	resp, err := do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("This operation was aborted")
		}
		return nil, errors.New("fetch failed")
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.New("fetch failed")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("Failed to fetch models: %d %s", resp.StatusCode, statusText(resp))
	}

	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, jsonSyntaxError(body)
	}

	ids, err := extractModelIDs(payload)
	if err != nil {
		return nil, err
	}
	sorted := sortModelIDs(ids)
	models := make([]any, 0, len(sorted))
	for _, id := range sorted {
		if id.defined {
			models = append(models, id.value)
		} else {
			models = append(models, nil)
		}
	}
	return models, nil
}

// extractModelIDs 复刻 `data.data?.map(m => m.id) ?? []` 的可观测语义：
//
//   - data 为 JSON null → 读属性抛 TypeError；
//   - data.data 为 null/undefined → `?.` 短路，`?? []` 得到空列表；
//   - data.data 不是数组 → `.map` 不是函数；
//   - 数组元素为 null → `m.id` 抛 TypeError；非对象元素 → id 是 undefined。
func extractModelIDs(payload any) ([]modelID, error) {
	switch data := payload.(type) {
	case nil:
		return nil, errors.New("Cannot read properties of null (reading 'data')")
	case map[string]any:
		value, present := data["data"]
		if !present || value == nil {
			return []modelID{}, nil
		}
		items, ok := value.([]any)
		if !ok {
			return nil, errors.New("data.data?.map is not a function")
		}
		ids := make([]modelID, 0, len(items))
		for _, item := range items {
			if item == nil {
				return nil, errors.New("Cannot read properties of null (reading 'id')")
			}
			object, ok := item.(map[string]any)
			if !ok {
				ids = append(ids, modelID{defined: false})
				continue
			}
			id, present := object["id"]
			ids = append(ids, modelID{value: id, defined: present})
		}
		return ids, nil
	}
	// 字符串/数字/布尔/数组：`data.data` 是 undefined → `?? []`。
	return []modelID{}, nil
}

// jsonSyntaxError 给出与 V8 相近的 JSON.parse 失败文案。空 body 是
// "Unexpected end of JSON input"，其余按 "Unexpected token ..." 处理；具体字符
// 位置不复刻（该字段是诊断文本，不是冻结契约）。
func jsonSyntaxError(body []byte) error {
	if len(strings.TrimSpace(string(body))) == 0 {
		return errors.New("Unexpected end of JSON input")
	}
	return errors.New("Unexpected token in JSON")
}

// statusText 从 Go 的 "401 Unauthorized" 形态里剥出 reason phrase。
func statusText(resp *http.Response) string {
	prefix := fmt.Sprintf("%d ", resp.StatusCode)
	return strings.TrimPrefix(resp.Status, prefix)
}

// testConnection 复刻 provider.ts 的 testConnection：按协议发一次最小生成
// 请求，返回 {ok, error}。它恰好只返回 ok 与错误消息，不暴露 provider 响应体。
func testConnection(ctx context.Context, do func(*http.Request) (*http.Response, error), cfg providerConfig) (bool, string) {
	req, err := buildProbeRequest(ctx, cfg)
	if err != nil {
		return false, err.Error()
	}

	resp, err := do(req)
	if err != nil {
		return false, "Cannot connect to API: " + err.Error()
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, "Cannot connect to API: " + err.Error()
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return false, providerErrorMessage(cfg.Protocol, body, statusText(resp))
	}
	return validateProbeResponse(cfg.Protocol, body)
}

// buildProbeRequest 构造三协议各自的最小非流式生成请求。
func buildProbeRequest(ctx context.Context, cfg providerConfig) (*http.Request, error) {
	var (
		target  string
		body    map[string]any
		headers map[string]string
	)

	prompt := "Hi"
	switch cfg.Protocol {
	case "anthropic":
		base, err := anthropicBaseURL(cfg.APIURL)
		if err != nil {
			return nil, err
		}
		target = base + "/messages"
		body = map[string]any{
			"model":      cfg.Model,
			"max_tokens": 5,
			"messages": []any{
				map[string]any{"role": "user", "content": []any{
					map[string]any{"type": "text", "text": prompt},
				}},
			},
		}
		headers = map[string]string{
			"x-api-key":         cfg.APIKey,
			"anthropic-version": "2023-06-01",
		}
	case "openai-compatible":
		base, err := probeBaseURL(cfg.APIURL)
		if err != nil {
			return nil, err
		}
		target = base + "/chat/completions"
		// Chat Completions 的转换器把「单段文本」压成字符串 content（数组形态
		// 只在多段/文件时出现），这里照 SDK 的请求形状。
		body = map[string]any{
			"model": cfg.Model,
			"messages": []any{
				map[string]any{"role": "user", "content": prompt},
			},
			"max_tokens": 5,
		}
		headers = map[string]string{"Authorization": "Bearer " + cfg.APIKey}
	default: // "openai"（Responses API）及其它未识别协议
		base, err := probeBaseURL(cfg.APIURL)
		if err != nil {
			return nil, err
		}
		target = base + "/responses"
		body = map[string]any{
			"model": cfg.Model,
			"input": []any{
				map[string]any{"role": "user", "content": []any{
					map[string]any{"type": "input_text", "text": prompt},
				}},
			},
			"max_output_tokens": 5,
		}
		headers = map[string]string{"Authorization": "Bearer " + cfg.APIKey}
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if !isValidFetchURL(target) {
		return nil, fmt.Errorf("Failed to parse URL from %s", target)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("Failed to parse URL from %s", target)
	}
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	applyTraceHeaders(ctx, req)
	return req, nil
}

// providerErrorMessage 复刻各 provider failedResponseHandler 的 errorToMessage：
// openai 系只要求 `error.message` 是字符串；anthropic 的 schema 还要求顶层
// `type:"error"` 与 `error.type`，不匹配时回落到 statusText。
func providerErrorMessage(protocol string, body []byte, fallback string) string {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return fallback
	}
	errorObject, ok := payload["error"].(map[string]any)
	if !ok {
		return fallback
	}
	if protocol == "anthropic" {
		if kind, _ := payload["type"].(string); kind != "error" {
			return fallback
		}
		if _, ok := errorObject["type"].(string); !ok {
			return fallback
		}
	}
	if message, ok := errorObject["message"].(string); ok {
		return message
	}
	return fallback
}

// validateProbeResponse 复刻 generateText 成功路径的响应校验：2xx 但响应体
// 不可解析或缺少该协议的最小结构时，AI SDK 的 postToApi 会抛
// "Failed to process successful response"。
//
// Responses API 的 doGenerate 还会显式检查成功体里的 `error` 字段并以其 message
// 抛 APICallError（其余两个协议没有这个分支）。
func validateProbeResponse(protocol string, body []byte) (bool, string) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false, "Failed to process successful response"
	}

	switch protocol {
	case "anthropic":
		if _, ok := payload["content"].([]any); !ok {
			return false, "Failed to process successful response"
		}
	case "openai-compatible":
		choices, ok := payload["choices"].([]any)
		if !ok || len(choices) == 0 {
			return false, "Failed to process successful response"
		}
	default:
		if errorObject, ok := payload["error"].(map[string]any); ok {
			if message, ok := errorObject["message"].(string); ok {
				return false, message
			}
			return false, "Failed to process successful response"
		}
		if _, ok := payload["output"].([]any); !ok {
			return false, "Failed to process successful response"
		}
	}
	return true, ""
}
