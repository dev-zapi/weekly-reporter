package aiclient_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
)

// responsesCreated / responsesCompleted 是 Responses SSE 的两端事件。
func responsesCreated(id string) [2]string {
	return [2]string{"response.created", fmt.Sprintf(
		`{"type":"response.created","sequence_number":0,"response":{"id":%q,"object":"response","created_at":1,"status":"in_progress","model":"mock-model","output":[]}}`, id)}
}

func responsesCompleted(id string, output string) [2]string {
	if output == "" {
		output = "[]"
	}
	return [2]string{"response.completed", fmt.Sprintf(
		`{"type":"response.completed","sequence_number":99,"response":{"id":%q,"object":"response","created_at":1,"status":"completed","model":"mock-model","output":%s}}`, id, output)}
}

const functionCallItem = `{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"query_report_list","arguments":"{\"query\":\"x\"}"}`

// TestResponsesStepStreamsToolCall 回放 Responses 流：reasoning summary、文本、
// function_call 的 added/delta/done + output_item.done 三重路径都要归一化，
// tool-call 只能发一次（flushed 标记防双发）。
func TestResponsesStepStreamsToolCall(t *testing.T) {
	sse := sseLines([][2]string{
		responsesCreated("resp_1"),
		{"response.reasoning_summary_text.delta", `{"type":"response.reasoning_summary_text.delta","sequence_number":1,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"先看原稿"}`},
		{"response.output_text.delta", `{"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"准备查询。"}`},
		{"response.output_item.added", `{"type":"response.output_item.added","sequence_number":3,"output_index":1,"item":{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"query_report_list","arguments":""}}`},
		{"response.function_call_arguments.delta", `{"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_1","output_index":1,"delta":"{\"query\":"}`},
		{"response.function_call_arguments.delta", `{"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"fc_1","output_index":1,"delta":"\"x\"}"}`},
		{"response.function_call_arguments.done", `{"type":"response.function_call_arguments.done","sequence_number":6,"item_id":"fc_1","output_index":1,"arguments":"{\"query\":\"x\"}"}`},
		{"response.output_item.done", `{"type":"response.output_item.done","sequence_number":7,"output_index":1,"item":` + functionCallItem + `}`},
		responsesCompleted("resp_1", "["+functionCallItem+"]"),
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  fixture.server.URL + "/v1",
		APIKey:   "openai-key",
		Model:    "mock-model",
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
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].Name != "query_report_list" {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	if result.ResponseID != "resp_1" {
		t.Fatalf("response id = %q", result.ResponseID)
	}

	if fixture.requests != 1 {
		t.Fatalf("requests = %d", fixture.requests)
	}
	if fixture.paths[0] != "/v1/responses" {
		t.Fatalf("path = %q, want /v1/responses", fixture.paths[0])
	}
	request := fixture.bodies[0]
	if request["model"] != "mock-model" {
		t.Fatalf("model = %v", request["model"])
	}
	if request["stream"] != true {
		t.Fatalf("stream = %v", request["stream"])
	}
	if request["max_output_tokens"] != float64(16_000) {
		t.Fatalf("max_output_tokens = %v", request["max_output_tokens"])
	}
	if request["temperature"] != 0.3 {
		t.Fatalf("temperature = %v", request["temperature"])
	}
	if _, present := request["previous_response_id"]; present {
		t.Fatalf("first step must not carry previous_response_id: %v", request["previous_response_id"])
	}
	if request["tool_choice"] != "auto" {
		t.Fatalf("tool_choice = %v", request["tool_choice"])
	}
	input := sliceOfMaps(t, request["input"])
	if len(input) != 2 {
		t.Fatalf("input = %#v", request["input"])
	}
	if input[0]["role"] != "system" || input[0]["content"] != "SYS" {
		t.Fatalf("system input item = %#v", input[0])
	}
	if input[1]["role"] != "user" {
		t.Fatalf("user input item = %#v", input[1])
	}
	parts := sliceOfMaps(t, input[1]["content"])
	if len(parts) != 1 || parts[0]["type"] != "input_text" || parts[0]["text"] != "写周报" {
		t.Fatalf("user content = %#v", input[1]["content"])
	}
	tools := sliceOfMaps(t, request["tools"])
	if len(tools) != 1 || tools[0]["type"] != "function" || tools[0]["name"] != "query_report_list" {
		t.Fatalf("tools = %#v", request["tools"])
	}
	// ADR-0027：tool 的 strict 字段省略（与显式 false 等价）。
	if _, present := tools[0]["strict"]; present {
		t.Fatalf("strict must be omitted: %#v", tools[0])
	}
	if got := fixture.headers[0].Get("Authorization"); got != "Bearer openai-key" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := fixture.headers[0].Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}
}

// TestResponsesStepContinuesWithPreviousResponseID 默认续轮形态：只带
// function_call_output + previous_response_id。
func TestResponsesStepContinuesWithPreviousResponseID(t *testing.T) {
	first := sseLines([][2]string{
		responsesCreated("resp_1"),
		{"response.output_item.added", `{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"query_report_list","arguments":""}}`},
		{"response.function_call_arguments.done", `{"type":"response.function_call_arguments.done","sequence_number":2,"item_id":"fc_1","output_index":0,"arguments":"{\"query\":\"x\"}"}`},
		{"response.output_item.done", `{"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":` + functionCallItem + `}`},
		responsesCompleted("resp_1", "["+functionCallItem+"]"),
	})
	second := sseLines([][2]string{
		responsesCreated("resp_2"),
		{"response.output_text.delta", `{"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"收到。"}`},
		responsesCompleted("resp_2", ""),
	})
	fixture := newStepFixtureServer(t, first, second)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  fixture.server.URL + "/v1",
		APIKey:   "k",
		Model:    "mock-model",
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
		FunctionOutputs: []aiclient.FunctionOutputItem{{CallID: "call_1", Name: "query_report_list", Output: `{"ok":true}`}},
	}, func(aiclient.Event) error { return nil })
	if err != nil {
		t.Fatalf("second RunStep: %v", err)
	}
	if result.ResponseID != "resp_2" {
		t.Fatalf("response id = %q", result.ResponseID)
	}

	request := fixture.bodies[1]
	if request["previous_response_id"] != "resp_1" {
		t.Fatalf("previous_response_id = %v", request["previous_response_id"])
	}
	// previous_response_id 下 system 不继承，必须走 instructions。
	if request["instructions"] != "SYS" {
		t.Fatalf("instructions = %v", request["instructions"])
	}
	input := sliceOfMaps(t, request["input"])
	if len(input) != 1 {
		t.Fatalf("input = %#v", request["input"])
	}
	if input[0]["type"] != "function_call_output" || input[0]["call_id"] != "call_1" || input[0]["output"] != `{"ok":true}` {
		t.Fatalf("function output item = %#v", input[0])
	}
}

// TestResponsesStepReplaysOutputItems 开关打开后的回放续轮：不用
// previous_response_id，改回放 transcript + 上一步 output items + tool 结果。
func TestResponsesStepReplaysOutputItems(t *testing.T) {
	first := sseLines([][2]string{
		responsesCreated("resp_1"),
		{"response.output_item.added", `{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"query_report_list","arguments":""}}`},
		{"response.function_call_arguments.done", `{"type":"response.function_call_arguments.done","sequence_number":2,"item_id":"fc_1","output_index":0,"arguments":"{\"query\":\"x\"}"}`},
		{"response.output_item.done", `{"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":` + functionCallItem + `}`},
		responsesCompleted("resp_1", "["+functionCallItem+"]"),
	})
	second := sseLines([][2]string{
		responsesCreated("resp_2"),
		responsesCompleted("resp_2", ""),
	})
	fixture := newStepFixtureServer(t, first, second)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  fixture.server.URL + "/v1",
		APIKey:   "k",
		Model:    "mock-model",
	}, []aiclient.Tool{testTool("query_report_list", "查询历史周报")}, aiclient.WithReplayOutputItems(true))

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
		FunctionOutputs: []aiclient.FunctionOutputItem{{CallID: "call_1", Name: "query_report_list", Output: `{"ok":true}`}},
	}, func(aiclient.Event) error { return nil }); err != nil {
		t.Fatalf("second RunStep: %v", err)
	}

	request := fixture.bodies[1]
	if _, present := request["previous_response_id"]; present {
		t.Fatalf("items replay must not carry previous_response_id: %v", request["previous_response_id"])
	}
	if _, present := request["instructions"]; present {
		t.Fatalf("items replay keeps system in input: %v", request["instructions"])
	}
	input := sliceOfMaps(t, request["input"])
	if len(input) != 4 {
		t.Fatalf("input = %#v", request["input"])
	}
	if input[0]["role"] != "system" {
		t.Fatalf("input[0] = %#v", input[0])
	}
	if input[1]["role"] != "user" {
		t.Fatalf("input[1] = %#v", input[1])
	}
	if input[2]["type"] != "function_call" || input[2]["call_id"] != "call_1" {
		t.Fatalf("replayed function call = %#v", input[2])
	}
	if input[3]["type"] != "function_call_output" || input[3]["call_id"] != "call_1" {
		t.Fatalf("function output = %#v", input[3])
	}
}

// TestResponsesStepHandlesProxyWithoutAddedEvents 兼容代理只发 done 事件时
// 也要补发 tool-input-start 并产出一次 tool-call（三重兜底）。
func TestResponsesStepHandlesProxyWithoutAddedEvents(t *testing.T) {
	sse := sseLines([][2]string{
		responsesCreated("resp_1"),
		{"response.output_item.done", `{"type":"response.output_item.done","sequence_number":1,"output_index":0,"item":` + functionCallItem + `}`},
		responsesCompleted("resp_1", "["+functionCallItem+"]"),
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  fixture.server.URL + "/v1",
		Model:    "mock-model",
	}, []aiclient.Tool{testTool("query_report_list", "查询历史周报")})

	var events []aiclient.Event
	result, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "写周报"}},
	}, func(event aiclient.Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	assertEventKinds(t, events, []string{
		"tool-input-start:query_report_list/call_1",
		"tool-call:query_report_list/call_1/{\"query\":\"x\"}",
	})
	if len(result.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
}

// TestResponsesStepSurfacesStreamErrors response.failed 要变成错误。
func TestResponsesStepSurfacesStreamErrors(t *testing.T) {
	sse := sseLines([][2]string{
		responsesCreated("resp_1"),
		{"response.failed", `{"type":"response.failed","sequence_number":1,"response":{"id":"resp_1","object":"response","created_at":1,"status":"failed","model":"mock-model","output":[],"error":{"code":"server_error","message":"boom"}}}`},
	})
	fixture := newStepFixtureServer(t, sse)

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  fixture.server.URL + "/v1",
		Model:    "mock-model",
	}, nil)

	_, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "写周报"}},
	}, func(aiclient.Event) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v", err)
	}
}

// TestResponsesStepOmitsTemperatureForReasoningModels 与 @ai-sdk/openai 一致：
// 推理模型不发 temperature / max_output_tokens 之外也不发 sampling 参数。
func TestResponsesStepOmitsTemperatureForReasoningModels(t *testing.T) {
	fixture := newStepFixtureServer(t, sseLines([][2]string{
		responsesCreated("resp_1"),
		responsesCompleted("resp_1", ""),
	}))

	provider := aiclient.NewStepProvider(aiclient.Config{
		Protocol: aiclient.ProtocolOpenAI,
		BaseURL:  fixture.server.URL + "/v1",
		Model:    "o3-mini",
	}, nil)
	if _, err := provider.RunStep(context.Background(), aiclient.StepRequest{
		Messages: []aiclient.TranscriptMessage{{Role: "user", Text: "hi"}},
	}, func(aiclient.Event) error { return nil }); err != nil {
		t.Fatalf("RunStep: %v", err)
	}
	if _, present := fixture.bodies[0]["temperature"]; present {
		t.Fatalf("temperature must be omitted for reasoning models: %v", fixture.bodies[0])
	}
}

// 保留 json import 的显式使用，避免测试收缩后误删依赖。
var _ = json.Marshal
