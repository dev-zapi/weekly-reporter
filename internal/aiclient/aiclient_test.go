package aiclient_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
)

// 本文件覆盖 one-shot 用到的三条协议路径：只断言「请求形状 + 输出提取」这两件
// 可观测事实。B6 的完整三协议 adapter（流式事件归一化、tool-loop、items 回放）
// 不在本票范围。

const testSchema = `{"type":"object","properties":{"polishedContent":{"type":"string"}},"required":["polishedContent"]}`

type captured struct {
	path    string
	headers http.Header
	body    map[string]any
}

func newServer(t *testing.T, handler func(w http.ResponseWriter, body map[string]any)) (*httptest.Server, *[]captured) {
	t.Helper()

	var requests []captured
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		requests = append(requests, captured{path: r.URL.Path, headers: r.Header.Clone(), body: body})
		handler(w, body)
	}))
	t.Cleanup(server.Close)
	return server, &requests
}

func writeJSON(w http.ResponseWriter, payload string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(payload))
}

func TestGenerateObjectResponsesProtocol(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\"ok\":1}"}]}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  server.URL + "/v1",
		APIKey:   "test-key",
		Model:    "mock-model",
	})
	text, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt:      "hi",
		Temperature: 0.3,
		Schema:      json.RawMessage(testSchema),
	})
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if text != `{"ok":1}` {
		t.Fatalf("text = %q", text)
	}

	if len(*requests) != 1 {
		t.Fatalf("requests = %d", len(*requests))
	}
	req := (*requests)[0]
	if req.path != "/v1/responses" {
		t.Fatalf("path = %q, want /v1/responses", req.path)
	}
	if got := req.headers.Get("Authorization"); got != "Bearer test-key" {
		t.Fatalf("Authorization = %q", got)
	}
	if req.body["model"] != "mock-model" {
		t.Fatalf("model = %v", req.body["model"])
	}
	if req.body["temperature"] != 0.3 {
		t.Fatalf("temperature = %v", req.body["temperature"])
	}

	textConfig, _ := req.body["text"].(map[string]any)
	format, _ := textConfig["format"].(map[string]any)
	if format["type"] != "json_schema" || format["strict"] != true {
		t.Fatalf("text.format = %v", format)
	}
	schema, _ := format["schema"].(map[string]any)
	if schema["required"] == nil {
		t.Fatalf("schema not forwarded: %v", format["schema"])
	}
}

func TestGenerateObjectChatCompletionsProtocol(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"choices":[{"message":{"content":"{\"ok\":2}"}}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Model:    "mock-model",
	})
	text, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt:      "hi",
		Temperature: 0.7,
		Schema:      json.RawMessage(testSchema),
	})
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if text != `{"ok":2}` {
		t.Fatalf("text = %q", text)
	}

	req := (*requests)[0]
	if req.path != "/chat/completions" {
		t.Fatalf("path = %q, want /chat/completions", req.path)
	}
	messages, _ := req.body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %v", req.body["messages"])
	}
	message, _ := messages[0].(map[string]any)
	if message["role"] != "user" || message["content"] != "hi" {
		t.Fatalf("message = %v", message)
	}
	format, _ := req.body["response_format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("response_format = %v", format)
	}
}

func TestGenerateObjectAnthropicProtocol(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"content":[{"type":"text","text":"{\"ok\":3}"}]}`)
	})

	// 用能力表里「支持原生结构化输出」的模型名，走 output_config.format 路径。
	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolAnthropic,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Model:    "claude-sonnet-4-5-20250929",
	})
	text, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt:      "hi",
		Temperature: 0.5,
		Schema:      json.RawMessage(testSchema),
	})
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if text != `{"ok":3}` {
		t.Fatalf("text = %q", text)
	}

	req := (*requests)[0]
	if req.path != "/messages" {
		t.Fatalf("path = %q, want /messages", req.path)
	}
	if got := req.headers.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("anthropic-version = %q, want 2023-06-01", got)
	}
	if got := req.headers.Get("x-api-key"); got != "test-key" {
		t.Fatalf("x-api-key = %q", got)
	}
	if got := req.headers.Get("anthropic-beta"); !strings.Contains(got, "structured-outputs-2025-11-13") {
		t.Fatalf("anthropic-beta = %q", got)
	}
	outputConfig, _ := req.body["output_config"].(map[string]any)
	format, _ := outputConfig["format"].(map[string]any)
	if format["type"] != "json_schema" {
		t.Fatalf("output_config.format = %v", format)
	}
}

// NaN 温度（ai_styles.temperature 解析失败）按 JSON.stringify 语义写成 null。
func TestGenerateObjectWritesNaNTemperatureAsNull(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"choices":[{"message":{"content":"{}"}}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  server.URL,
		Model:    "mock-model",
	})
	if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt:      "hi",
		Temperature: nan(),
		Schema:      json.RawMessage(testSchema),
	}); err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}

	temperature, present := (*requests)[0].body["temperature"]
	if !present || temperature != nil {
		t.Fatalf("temperature = %v (present=%v), want null", temperature, present)
	}
}

// 非 2xx 与「2xx 但没有对象文本」都是错误。
func TestGenerateObjectErrors(t *testing.T) {
	t.Run("http error", func(t *testing.T) {
		server, _ := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
			// 400 不可重试，测试因此不等待退避。
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, `{"error":"boom"}`)
		})
		client := aiclient.New(aiclient.Config{
			Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
		})
		if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
			Prompt: "hi", Schema: json.RawMessage(testSchema),
		}); err == nil {
			t.Fatal("want error for non-2xx response")
		}
	})

	t.Run("no object", func(t *testing.T) {
		server, _ := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
			writeJSON(w, `{"choices":[]}`)
		})
		client := aiclient.New(aiclient.Config{
			Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
		})
		if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
			Prompt: "hi", Schema: json.RawMessage(testSchema),
		}); err != aiclient.ErrNoObject {
			t.Fatalf("err = %v, want ErrNoObject", err)
		}
	})
}

func nan() float64 {
	var zero float64
	return zero / zero
}

// AI SDK 默认 maxRetries=2：429/5xx 与网络错误重试，4xx 不重试。测试用
// retry-after-ms: 0 让退避立即发生（SDK 同样接受该值）。
func TestGenerateObjectRetriesRetryableStatus(t *testing.T) {
	var attempts int
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After-Ms", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			writeJSON(w, `{"error":{"message":"slow down"}}`)
			return
		}
		writeJSON(w, `{"choices":[{"message":{"content":"{\"ok\":4}"}}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
	})
	text, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Schema: json.RawMessage(testSchema),
	})
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if text != `{"ok":4}` {
		t.Fatalf("text = %q", text)
	}
	if len(*requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(*requests))
	}
}

func TestGenerateObjectDoesNotRetryNonRetryableStatus(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, `{"error":{"message":"bad"}}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
	})
	if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Schema: json.RawMessage(testSchema),
	}); err == nil {
		t.Fatal("want error for non-retryable status")
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(*requests))
	}
}

// 2xx 响应头已到达、响应体被截断（连接中断）：SDK 把它包成 statusCode=2xx 的
// APICallError（"Failed to process successful response"），isRetryable 走构造器
// 默认按状态码判定 → false，因此不重试。Go 侧必须同样只发一次请求。
func TestGenerateObjectDoesNotRetryTruncatedSuccessBody(t *testing.T) {
	var attempts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		// 声明 128 字节，只写一小段就断开连接。
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{\"choices\":[")
		_ = buf.Flush()
		_ = conn.Close()
	}))
	t.Cleanup(server.Close)

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
	})
	if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Schema: json.RawMessage(testSchema),
	}); err == nil {
		t.Fatal("want error for a truncated success body")
	} else if !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("err = %v, want an underlying unexpected EOF", err)
	}
	if attempts != 1 {
		t.Fatalf("requests = %d, want 1 (SDK does not retry a failed successful response)", attempts)
	}
}

// 非 2xx 的读体失败相反：SDK 的 "Failed to process error response" 继承按状态码
// 判定的 isRetryable（429 → true），因此仍重试。
func TestGenerateObjectRetriesTruncatedErrorBody(t *testing.T) {
	var attempts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		if attempts > 1 {
			writeJSON(w, `{"choices":[{"message":{"content":"{\"ok\":5}"}}]}`)
			return
		}
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After-Ms: 0\r\nContent-Length: 128\r\n\r\n{\"error\":")
		_ = buf.Flush()
		_ = conn.Close()
	}))
	t.Cleanup(server.Close)

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
	})
	text, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Schema: json.RawMessage(testSchema),
	})
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if text != `{"ok":5}` {
		t.Fatalf("text = %q", text)
	}
	if attempts != 2 {
		t.Fatalf("requests = %d, want 2", attempts)
	}
}

func TestGenerateObjectGivesUpAfterMaxRetries(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Retry-After-Ms", "0")
		w.WriteHeader(http.StatusInternalServerError)
		writeJSON(w, `{"error":{"message":"boom"}}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible, BaseURL: server.URL, Model: "m",
	})
	_, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Schema: json.RawMessage(testSchema),
	})
	if err == nil {
		t.Fatal("want error after retries are exhausted")
	}
	if want := "Failed after 3 attempts"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want %q", err, want)
	}
	if len(*requests) != 3 {
		t.Fatalf("requests = %d, want 3", len(*requests))
	}
}

// 不支持原生结构化输出的 anthropic 模型（含自定义模型名）退回「单个 json 工具 +
// tool_choice any」路径，响应从 tool_use.input 取对象（AI SDK 的同款 fallback）。
func TestGenerateObjectAnthropicFallsBackToJSONTool(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"content":[{"type":"tool_use","name":"json","input":{"polishedContent":"ok"}}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolAnthropic,
		BaseURL:  server.URL,
		APIKey:   "test-key",
		Model:    "custom-model",
	})
	text, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Temperature: 0.3, Schema: json.RawMessage(testSchema),
	})
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if text != `{"polishedContent":"ok"}` {
		t.Fatalf("text = %q", text)
	}

	req := (*requests)[0]
	if _, present := req.body["output_config"]; present {
		t.Fatalf("output_config must be omitted on the json-tool path: %v", req.body["output_config"])
	}
	tools, _ := req.body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v", req.body["tools"])
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "json" {
		t.Fatalf("tool = %v", tool)
	}
	choice, _ := req.body["tool_choice"].(map[string]any)
	if choice["type"] != "any" || choice["disable_parallel_tool_use"] != true {
		t.Fatalf("tool_choice = %v", choice)
	}
}

// 拒绝采样参数的模型不发 temperature（ADR-0027 里 2026-10-21 版本会 400 的那类）。
func TestGenerateObjectAnthropicOmitsTemperatureForRejectingModels(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"content":[{"type":"text","text":"{}"}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolAnthropic,
		BaseURL:  server.URL,
		Model:    "claude-sonnet-5-20260101",
	})
	if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Temperature: 0.3, Schema: json.RawMessage(testSchema),
	}); err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if _, present := (*requests)[0].body["temperature"]; present {
		t.Fatalf("temperature must be omitted, body = %v", (*requests)[0].body)
	}
}

// 超出 [0,1] 的 anthropic 温度被夹取（AI SDK 的同款行为）。
func TestGenerateObjectAnthropicClampsTemperature(t *testing.T) {
	server, requests := newServer(t, func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, `{"content":[{"type":"text","text":"{}"}]}`)
	})

	client := aiclient.New(aiclient.Config{
		Protocol: aiclient.ProtocolAnthropic,
		BaseURL:  server.URL,
		Model:    "claude-sonnet-4-5-20250929",
	})
	if _, err := client.GenerateObject(context.Background(), aiclient.ObjectRequest{
		Prompt: "hi", Temperature: 1.5, Schema: json.RawMessage(testSchema),
	}); err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if got := (*requests)[0].body["temperature"]; got != 1.0 {
		t.Fatalf("temperature = %v, want 1", got)
	}
}
