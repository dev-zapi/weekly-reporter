package aiclient_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
)

// compatChunk 按 Chat Completions 的 SSE 形态拼一行 data。
func compatChunk(payload string) [2]string { return [2]string{"", payload} }

func compatDone() [2]string { return [2]string{"", "[DONE]"} }

// TestCompatStepStreamsReasoningAndToolCall 回放兼容代理的 SSE：reasoning 字段
// （reasoning_content / reasoning / thinking）直读成 reasoning-delta，content
// 成 text-delta，tool_calls 增量聚合成 tool-call；请求必须是 /chat/completions。
func TestCompatStepStreamsReasoningAndToolCall(t *testing.T) {
	sse := sseLines([][2]string{
		compatChunk(`{"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"先看原稿"}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{"content":"准备查询。"}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"query_report_list","arguments":"{\"query\":"}}]}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`),
		compatDone(),
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  fixture.server.URL + "/v1",
		APIKey:   "compat-key",
		Model:    "e2e-scripted",
	}, []aiclient.Tool{testTool("query_report_list", "查询历史周报")})

	var events []aiclient.Event
	result, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		System:          "SYS",
		Messages:        []aiclient.TranscriptMessage{{Role: "user", Text: "写周报"}},
		Temperature:     0.3,
		MaxOutputTokens: 16_000,
	}, func(event aiclient.Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("RunStep: %v", err)
	}

	assertEventKinds(t, events, []string{
		"reasoning:先看原稿",
		"text:准备查询。",
		"tool-input-start:query_report_list/call_1",
		"tool-input-delta:query_report_list/call_1",
		"tool-input-delta:query_report_list/call_1",
		"tool-call:query_report_list/call_1/{\"query\":\"x\"}",
	})
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "call_1" || result.ToolCalls[0].Input != `{"query":"x"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}

	request := fixture.bodies[0]
	if fixture.paths[0] != "/v1/chat/completions" {
		t.Fatalf("path = %q, want /v1/chat/completions", fixture.paths[0])
	}
	if request["model"] != "e2e-scripted" {
		t.Fatalf("model = %v", request["model"])
	}
	// ADR-0027：兼容路径必须继续发 /chat/completions（marker 协议依赖）。
	if request["stream"] != true {
		t.Fatalf("stream = %v", request["stream"])
	}
	if request["max_tokens"] != float64(16_000) {
		t.Fatalf("max_tokens = %v", request["max_tokens"])
	}
	if request["temperature"] != 0.3 {
		t.Fatalf("temperature = %v", request["temperature"])
	}
	options := mustJSON(t, request["stream_options"])
	if options["include_usage"] != true {
		t.Fatalf("stream_options = %#v", request["stream_options"])
	}
	messages := sliceOfMaps(t, request["messages"])
	if len(messages) != 2 || messages[0]["role"] != "system" || messages[1]["role"] != "user" {
		t.Fatalf("messages = %#v", request["messages"])
	}
	if messages[1]["content"] != "写周报" {
		t.Fatalf("user content = %#v", messages[1])
	}
	tools := sliceOfMaps(t, request["tools"])
	if len(tools) != 1 || tools[0]["type"] != "function" {
		t.Fatalf("tools = %#v", request["tools"])
	}
	function := mustJSON(t, tools[0]["function"])
	if function["name"] != "query_report_list" {
		t.Fatalf("function = %#v", function)
	}
	if got := fixture.headers[0].Get("Authorization"); got != "Bearer compat-key" {
		t.Fatalf("Authorization = %q", got)
	}
}

// TestCompatStepReplaysAssistantToolCalls 续轮的消息历史形状（user 文本 +
// assistant tool_calls 回放 + tool 结果）必须与 scripted-AI 的 marker 协议一致。
func TestCompatStepReplaysAssistantToolCalls(t *testing.T) {
	first := sseLines([][2]string{
		compatChunk(`{"choices":[{"index":0,"delta":{"content":"查询中"}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"e2e-tool-1","type":"function","function":{"name":"query_report_list","arguments":"{\"query\":\"x\"}"}}]}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`),
		compatDone(),
	})
	second := sseLines([][2]string{
		compatChunk(`{"choices":[{"index":0,"delta":{"content":"收到"}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`),
		compatDone(),
	})
	fixture := newStepFixtureServer(t, first, second)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  fixture.server.URL + "/v1",
		Model:    "e2e-scripted",
	}, []aiclient.Tool{testTool("query_report_list", "查询历史周报")})

	req := aiclient.StepRequest{
		System:          "SYS",
		Messages:        []aiclient.TranscriptMessage{{Role: "user", Text: "写周报"}},
		Temperature:     0.3,
		MaxOutputTokens: 16_000,
	}
	if _, err := provider.RunStep(context.Background(), req, func(aiclient.Event) error { return nil }); err != nil {
		t.Fatalf("first RunStep: %v", err)
	}
	if _, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		System:          "SYS",
		Temperature:     0.3,
		MaxOutputTokens: 16_000,
		FunctionOutputs: []aiclient.FunctionOutputItem{{CallID: "e2e-tool-1", Name: "query_report_list", Output: `{"ok":true}`}},
	}, func(aiclient.Event) error { return nil }); err != nil {
		t.Fatalf("second RunStep: %v", err)
	}

	// 请求仍发 /chat/completions（不是 /responses）。
	messages := sliceOfMaps(t, fixture.bodies[1]["messages"])
	if len(messages) != 4 {
		t.Fatalf("messages = %#v", messages)
	}
	if messages[0]["role"] != "system" || messages[1]["role"] != "user" {
		t.Fatalf("messages = %#v", messages)
	}
	assistant := messages[2]
	if assistant["role"] != "assistant" || assistant["content"] != "查询中" {
		t.Fatalf("assistant message = %#v", assistant)
	}
	calls := sliceOfMaps(t, assistant["tool_calls"])
	if len(calls) != 1 || calls[0]["id"] != "e2e-tool-1" || calls[0]["type"] != "function" {
		t.Fatalf("assistant tool_calls = %#v", assistant["tool_calls"])
	}
	function := mustJSON(t, calls[0]["function"])
	if function["name"] != "query_report_list" || function["arguments"] != `{"query":"x"}` {
		t.Fatalf("replayed function = %#v", function)
	}
	tool := messages[3]
	if tool["role"] != "tool" || tool["tool_call_id"] != "e2e-tool-1" || tool["content"] != `{"ok":true}` {
		t.Fatalf("tool message = %#v", tool)
	}
}

// TestCompatStepPrefersReasoningContentOrder 同一 chunk 里既有 reasoning 又有
// content 时，先 reasoning 后 text（字段探测顺序 reasoning_content → reasoning
// → thinking）。
func TestCompatStepPrefersReasoningContentOrder(t *testing.T) {
	sse := sseLines([][2]string{
		compatChunk(`{"choices":[{"index":0,"delta":{"reasoning":"推理","content":"正文"}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{"thinking":"第二段推理"}}]}`),
		compatChunk(`{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`),
		compatDone(),
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  fixture.server.URL + "/v1",
		Model:    "m",
	}, nil)

	var events []aiclient.Event
	if _, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "hi"}},
	}, func(event aiclient.Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	assertEventKinds(t, events, []string{
		"reasoning:推理",
		"text:正文",
		"reasoning:第二段推理",
	})
}

// TestCompatStepSurfacesInBandErrors data 里的 error 对象要变成错误。
func TestCompatStepSurfacesInBandErrors(t *testing.T) {
	sse := sseLines([][2]string{
		compatChunk(`{"error":{"message":"scripted first-turn failure","type":"server_error"}}`),
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  fixture.server.URL + "/v1",
		Model:    "m",
	}, nil)
	_, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "hi"}},
	}, func(aiclient.Event) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "scripted first-turn failure") {
		t.Fatalf("err = %v", err)
	}
}

// TestCompatStepReturnsStatusErrorForNon2xx 非 2xx 不重试（400），错误要带状态码。
func TestCompatStepReturnsStatusErrorForNon2xx(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"bad request"}}`))
	}))
	t.Cleanup(server.Close)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  server.URL + "/v1",
		Model:    "m",
	}, nil)
	_, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "hi"}},
	}, func(aiclient.Event) error { return nil })
	if err == nil {
		t.Fatal("want error for non-2xx response")
	}
	statusError, ok := err.(*aiclient.StatusError)
	if !ok {
		t.Fatalf("err = %T, want *aiclient.StatusError", err)
	}
	if statusError.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", statusError.StatusCode)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1 (400 is not retryable)", requests)
	}
}

// TestCompatStepRetriesRetryableStatus 429 按 AI SDK 的重试语义再试一次
// （retry-after-ms: 0 让退避立即发生）。
func TestCompatStepRetriesRetryableStatus(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Retry-After-Ms", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"slow down"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseLines([][2]string{
			compatChunk(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`),
			compatDone(),
		})))
	}))
	t.Cleanup(server.Close)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAICompatible,
		BaseURL:  server.URL + "/v1",
		Model:    "m",
	}, nil)
	var events []aiclient.Event
	if _, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "hi"}},
	}, func(event aiclient.Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	assertEventKinds(t, events, []string{"text:ok"})
}
