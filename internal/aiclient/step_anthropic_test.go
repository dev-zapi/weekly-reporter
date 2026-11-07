package aiclient_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
)

// stepFixtureServer 回放一段 SSE，并把收到的请求记录下来。
type stepFixtureServer struct {
	t        *testing.T
	server   *httptest.Server
	bodies   []map[string]any
	headers  []http.Header
	paths    []string
	requests int
}

func newStepFixtureServer(t *testing.T, responses ...string) *stepFixtureServer {
	t.Helper()
	fixture := &stepFixtureServer{t: t}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("decode body %q: %v", string(raw), err)
		}
		fixture.bodies = append(fixture.bodies, body)
		fixture.headers = append(fixture.headers, r.Header.Clone())
		fixture.paths = append(fixture.paths, r.URL.Path)
		fixture.requests++

		w.Header().Set("Content-Type", "text/event-stream")
		index := fixture.requests - 1
		if index >= len(responses) {
			index = len(responses) - 1
		}
		_, _ = io.WriteString(w, responses[index])
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

// sseLines 拼接 SSE 事件；event 为空时只写 data 行（Chat Completions 风格）。
func sseLines(events [][2]string) string {
	var builder strings.Builder
	for _, event := range events {
		if event[0] != "" {
			fmt.Fprintf(&builder, "event: %s\n", event[0])
		}
		fmt.Fprintf(&builder, "data: %s\n\n", event[1])
	}
	return builder.String()
}

// eventKinds 把事件序列压成便于断言的 kind 名字列表。
func eventKinds(events []aiclient.Event) []string {
	kinds := make([]string, 0, len(events))
	for _, event := range events {
		switch event.Kind {
		case aiclient.EventReasoningDelta:
			kinds = append(kinds, "reasoning:"+event.Text)
		case aiclient.EventTextDelta:
			kinds = append(kinds, "text:"+event.Text)
		case aiclient.EventToolInputStart:
			kinds = append(kinds, "tool-input-start:"+event.ToolName+"/"+event.ToolCallID)
		case aiclient.EventToolInputDelta:
			kinds = append(kinds, "tool-input-delta:"+event.ToolName+"/"+event.ToolCallID)
		case aiclient.EventToolCall:
			kinds = append(kinds, "tool-call:"+event.ToolName+"/"+event.ToolCallID+"/"+event.Input)
		default:
			kinds = append(kinds, fmt.Sprintf("unknown-%d", event.Kind))
		}
	}
	return kinds
}

func assertEventKinds(t *testing.T, events []aiclient.Event, want []string) {
	t.Helper()
	got := eventKinds(events)
	if len(got) != len(want) {
		t.Fatalf("events = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("events = %#v, want %#v", got, want)
		}
	}
}

func mustJSON(t *testing.T, value any) map[string]any {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		return typed
	default:
		t.Fatalf("value is %T, want map", value)
		return nil
	}
}

func sliceOfMaps(t *testing.T, value any) []map[string]any {
	t.Helper()
	raw, ok := value.([]any)
	if !ok {
		t.Fatalf("value is %T, want array", value)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		out = append(out, mustJSON(t, item))
	}
	return out
}

func testTool(name, description string) aiclient.Tool {
	return aiclient.Tool{
		Name:        name,
		Description: description,
		Parameters:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"additionalProperties":false}`),
	}
}

// TestAnthropicStepStreamsToolCall 回放 anthropic 流：thinking/text/tool_use 增量
// 都要归一化成统一事件，tool_use 的入参由 input_json_delta 拼出完整 JSON。
func TestAnthropicStepStreamsToolCall(t *testing.T) {
	sse := sseLines([][2]string{
		{"message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}`},
		{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`},
		{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先看原稿"}}`},
		{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		{"content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`},
		{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"准备查询。"}}`},
		{"content_block_stop", `{"type":"content_block_stop","index":1}`},
		{"content_block_start", `{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"query_report_list","input":{}}}`},
		{"content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"上周\"}"}}`},
		{"content_block_stop", `{"type":"content_block_stop","index":2}`},
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}`},
		{"message_stop", `{"type":"message_stop"}`},
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolAnthropic,
		BaseURL:  fixture.server.URL,
		APIKey:   "anthropic-key",
		Model:    "claude-sonnet-4-5",
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
		"tool-input-start:query_report_list/toolu_1",
		"tool-input-delta:query_report_list/toolu_1",
		"tool-call:query_report_list/toolu_1/{\"query\":\"上周\"}",
	})
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "toolu_1" ||
		result.ToolCalls[0].Name != "query_report_list" || result.ToolCalls[0].Input != `{"query":"上周"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	if result.ResponseID != "msg_1" {
		t.Fatalf("response id = %q", result.ResponseID)
	}

	if fixture.requests != 1 {
		t.Fatalf("requests = %d", fixture.requests)
	}
	if fixture.paths[0] != "/messages" {
		t.Fatalf("path = %q, want /messages", fixture.paths[0])
	}
	request := fixture.bodies[0]
	if request["model"] != "claude-sonnet-4-5" {
		t.Fatalf("model = %v", request["model"])
	}
	if request["max_tokens"] != float64(16_000) {
		t.Fatalf("max_tokens = %v", request["max_tokens"])
	}
	if request["temperature"] != 0.3 {
		t.Fatalf("temperature = %v", request["temperature"])
	}
	if request["stream"] != true {
		t.Fatalf("stream = %v", request["stream"])
	}
	system := sliceOfMaps(t, request["system"])
	if len(system) != 1 || system[0]["text"] != "SYS" {
		t.Fatalf("system = %#v", request["system"])
	}
	messages := sliceOfMaps(t, request["messages"])
	if len(messages) != 1 || messages[0]["role"] != "user" {
		t.Fatalf("messages = %#v", request["messages"])
	}
	tools := sliceOfMaps(t, request["tools"])
	if len(tools) != 1 || tools[0]["name"] != "query_report_list" {
		t.Fatalf("tools = %#v", request["tools"])
	}
	if schema := mustJSON(t, tools[0]["input_schema"]); schema["additionalProperties"] != false {
		t.Fatalf("input_schema = %#v", schema)
	}
	if tools[0]["eager_input_streaming"] != true {
		t.Fatalf("eager_input_streaming = %#v", tools[0])
	}

	// ADR-0027：anthropic-version 必须钉回 2023-06-01（SDK 默认会变）。
	header := fixture.headers[0]
	if got := header.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("anthropic-version = %q", got)
	}
	if got := header.Get("x-api-key"); got != "anthropic-key" {
		t.Fatalf("x-api-key = %q", got)
	}
	if got := header.Get("anthropic-beta"); !strings.Contains(got, "structured-outputs-2025-11-13") {
		t.Fatalf("anthropic-beta = %q", got)
	}
}

// TestAnthropicStepReplaysAssistantTurnAndToolResults 续轮：assistant 的 tool_use
// 块原样回放，tool_result 作为同一条 user 消息发送。
func TestAnthropicStepReplaysAssistantTurnAndToolResults(t *testing.T) {
	first := sseLines([][2]string{
		{"message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}`},
		{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"query_report_list","input":{}}}`},
		{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"x\"}"}}`},
		{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}`},
		{"message_stop", `{"type":"message_stop"}`},
	})
	second := sseLines([][2]string{
		{"message_start", `{"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}`},
		{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到。"}}`},
		{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`},
		{"message_stop", `{"type":"message_stop"}`},
	})
	fixture := newStepFixtureServer(t, first, second)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolAnthropic,
		BaseURL:  fixture.server.URL,
		APIKey:   "k",
		Model:    "claude-sonnet-4-5",
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
	result, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		System:          "SYS",
		Temperature:     0.3,
		MaxOutputTokens: 16_000,
		FunctionOutputs: []aiclient.FunctionOutputItem{{CallID: "toolu_1", Name: "query_report_list", Output: `{"ok":true}`}},
	}, func(aiclient.Event) error { return nil })
	if err != nil {
		t.Fatalf("second RunStep: %v", err)
	}
	if result.ResponseID != "msg_2" {
		t.Fatalf("response id = %q", result.ResponseID)
	}

	messages := sliceOfMaps(t, fixture.bodies[1]["messages"])
	if len(messages) != 3 {
		t.Fatalf("messages = %#v", messages)
	}
	assistant := messages[1]
	if assistant["role"] != "assistant" {
		t.Fatalf("assistant message = %#v", assistant)
	}
	blocks := sliceOfMaps(t, assistant["content"])
	if len(blocks) != 1 || blocks[0]["type"] != "tool_use" || blocks[0]["id"] != "toolu_1" {
		t.Fatalf("assistant content = %#v", assistant["content"])
	}
	if input := mustJSON(t, blocks[0]["input"]); input["query"] != "x" {
		t.Fatalf("tool_use input = %#v", blocks[0]["input"])
	}
	user := messages[2]
	if user["role"] != "user" {
		t.Fatalf("tool result message = %#v", user)
	}
	results := sliceOfMaps(t, user["content"])
	if len(results) != 1 || results[0]["type"] != "tool_result" || results[0]["tool_use_id"] != "toolu_1" {
		t.Fatalf("tool results = %#v", user["content"])
	}
}
