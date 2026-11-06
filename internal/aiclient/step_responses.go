package aiclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/packages/param"
	"github.com/openai/openai-go/v3/responses"
)

// responsesStepProvider 是 openai-responses 协议的流式 adapter
// （openai-go v3 Responses.NewStreaming）。
//
// 续轮有两种形态（ADR-0027 / 风险登记 #2）：
//   - 默认：只带本步的 function_call_output，链到上一步的 previous_response_id，
//     provider 侧持住 assistant turn（垂直切片原型实证的形态）；
//   - items 回放（ReplayOutputItems，默认关）：不用 previous_response_id，改把
//     transcript + 上一步的完整 output items + function outputs 全量回放，
//     供不持状态的兼容代理使用（与 @ai-sdk/openai 的默认行为一致）。
//
// 禁用它不会引入 BetaToolRunner：本包只用 SDK 的传输与事件解码，工具循环属于引擎。
type responsesStepProvider struct {
	cfg    Config
	tools  []Tool
	opts   StepOptions
	step   int
	prevID string
	// baseItems 是首步的 system + transcript（items 回放时每步都要重发）。
	baseItems []json.RawMessage
	// replayItems 是上一步 response.completed 里的 output items 原始 JSON，
	// 仅在 ReplayOutputItems 打开时用于回放。
	replayItems []json.RawMessage
}

// RunStep 实现 StepProvider。
func (p *responsesStepProvider) RunStep(ctx context.Context, req StepRequest, emit func(Event) error) (*StepResult, error) {
	base, err := (&Client{cfg: p.cfg}).baseURL(defaultOpenAIBaseURL)
	if err != nil {
		return nil, err
	}
	// provider.ts 用 `${baseURL}/responses` 直拼；SDK 会按 URL 语义重解析，对
	// "v1//" 这类退化输入不等价，因此这里同样用 middleware 钉死目标 URL。
	target, err := url.Parse(base + "/responses")
	if err != nil {
		return nil, err
	}
	origin, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	origin.Path = ""
	origin.RawQuery = ""
	origin.Fragment = ""

	body, err := p.buildRequest(req)
	if err != nil {
		return nil, err
	}

	options := append([]option.RequestOption{
		option.WithAPIKey(p.cfg.APIKey),
		option.WithBaseURL(origin.String()),
		option.WithMiddleware(func(r *http.Request, next option.MiddlewareNext) (*http.Response, error) {
			r.URL = target
			return next(r)
		}),
	}, traceRequestOptions(ctx)...)
	if _, isNull := temperatureJSON(req.Temperature); isNull && !isOpenAIReasoningModel(p.cfg.Model) {
		// JSON.stringify(NaN) === null：保持与 AI SDK 相同的 body 形状。
		options = append(options, option.WithJSONSet("temperature", nil))
	}

	client := openai.NewClient(options...)
	stream := client.Responses.NewStreaming(ctx, body)
	defer stream.Close()

	result := &StepResult{}
	pending := map[string]*pendingToolCall{}
	var order []string // item_id 的首次出现顺序

	complete := func(itemID string) error {
		call := pending[itemID]
		if call == nil || call.flushed {
			return nil
		}
		call.flushed = true
		input := call.args.String()
		if strings.TrimSpace(input) == "" {
			input = call.completedArgs
		}
		if input == "" {
			input = "{}"
		}
		result.ToolCalls = append(result.ToolCalls, StepToolCall{ID: call.callID, Name: call.name, Input: input})
		return emit(Event{Kind: EventToolCall, ToolCallID: call.callID, ToolName: call.name, Input: input})
	}

	for stream.Next() {
		event := stream.Current()
		switch event.Type {
		case "response.created":
			if id := createdResponseID(event); id != "" {
				result.ResponseID = id
			}

		case "response.output_item.added":
			item := event.Item
			if item.Type == "function_call" {
				call := item.AsFunctionCall()
				pending[item.ID] = &pendingToolCall{callID: call.CallID, name: call.Name}
				order = append(order, item.ID)
				if err := emit(Event{Kind: EventToolInputStart, ToolCallID: call.CallID, ToolName: call.Name}); err != nil {
					return nil, err
				}
			}

		case "response.output_text.delta":
			if err := emit(Event{Kind: EventTextDelta, Text: event.Delta}); err != nil {
				return nil, err
			}

		case "response.reasoning_summary_text.delta":
			if err := emit(Event{Kind: EventReasoningDelta, Text: event.Delta}); err != nil {
				return nil, err
			}

		case "response.function_call_arguments.delta":
			// delta 只带 item_id：映射到引擎用的 call_id，漏映射会全部错发 "tool"。
			callID, name := event.ItemID, ""
			if call := pending[event.ItemID]; call != nil {
				callID, name = call.callID, call.name
				call.args.WriteString(event.Delta)
			}
			if err := emit(Event{Kind: EventToolInputDelta, ToolCallID: callID, ToolName: name}); err != nil {
				return nil, err
			}

		case "response.function_call_arguments.done":
			if call := pending[event.ItemID]; call != nil {
				call.completedArgs = event.Arguments
			}

		case "response.output_item.done":
			item := event.Item
			if item.Type != "function_call" {
				break
			}
			call := item.AsFunctionCall()
			if _, ok := pending[item.ID]; !ok {
				// 代理没发 output_item.added：补发 tool-input-start。
				pending[item.ID] = &pendingToolCall{callID: call.CallID, name: call.Name}
				order = append(order, item.ID)
				if err := emit(Event{Kind: EventToolInputStart, ToolCallID: call.CallID, ToolName: call.Name}); err != nil {
					return nil, err
				}
			}
			if call.Arguments != "" {
				pending[item.ID].completedArgs = call.Arguments
			}
			if err := complete(item.ID); err != nil {
				return nil, err
			}

		case "response.completed":
			completed := event.AsResponseCompleted()
			if completed.Response.ID != "" {
				result.ResponseID = completed.Response.ID
			}
			if p.opts.ReplayOutputItems {
				// 回放模式下每步的 assistant 输出都要累积（多步循环里不能只留最后一步）。
				p.replayItems = append(p.replayItems, outputItemsRaw(event.RawJSON())...)
			}
			// 兜底：流事件从未surface 的 function call（三路之一）。
			for _, item := range completed.Response.Output {
				if item.Type != "function_call" {
					continue
				}
				if _, ok := pending[item.ID]; !ok {
					call := item.AsFunctionCall()
					pending[item.ID] = &pendingToolCall{callID: call.CallID, name: call.Name}
					order = append(order, item.ID)
					if err := emit(Event{Kind: EventToolInputStart, ToolCallID: call.CallID, ToolName: call.Name}); err != nil {
						return nil, err
					}
				}
				if call := item.AsFunctionCall(); call.Arguments != "" {
					pending[item.ID].completedArgs = call.Arguments
				}
				if err := complete(item.ID); err != nil {
					return nil, err
				}
			}

		case "response.failed":
			failed := event.AsResponseFailed()
			return nil, fmt.Errorf("response failed: %s", failed.Response.Error.Message)

		case "response.incomplete":
			incomplete := event.AsResponseIncomplete()
			return nil, fmt.Errorf("response incomplete: %s", incomplete.Response.IncompleteDetails.Reason)

		case "error":
			return nil, fmt.Errorf("stream error %s: %s", event.Code, event.Message)
		}
	}
	if err := stream.Err(); err != nil {
		return nil, streamError(ctx, err)
	}

	// 流正常结束却仍没收尾的 tool call（代理只发 delta）：按出现顺序补发。
	for _, itemID := range order {
		if err := complete(itemID); err != nil {
			return nil, err
		}
	}

	p.step++
	p.prevID = result.ResponseID
	return result, nil
}

// pendingToolCall 跟踪一个 function_call 的入参增量与收尾状态。
type pendingToolCall struct {
	callID        string
	name          string
	args          strings.Builder
	completedArgs string
	flushed       bool
}

// buildRequest 组装本步的 Responses 请求体。
func (p *responsesStepProvider) buildRequest(req StepRequest) (responses.ResponseNewParams, error) {
	body := responses.ResponseNewParams{Model: p.cfg.Model}
	if req.MaxOutputTokens > 0 {
		body.MaxOutputTokens = param.NewOpt(req.MaxOutputTokens)
	}
	reasoning := isOpenAIReasoningModel(p.cfg.Model)
	if !reasoning {
		if value, isNull := temperatureJSON(req.Temperature); !isNull {
			body.Temperature = param.NewOpt(value.(float64))
		}
	}

	if len(p.tools) > 0 {
		body.Tools = make([]responses.ToolUnionParam, 0, len(p.tools))
		for _, tool := range p.tools {
			var parameters map[string]any
			if len(tool.Parameters) > 0 {
				_ = json.Unmarshal(tool.Parameters, &parameters)
			}
			body.Tools = append(body.Tools, responses.ToolUnionParam{OfFunction: &responses.FunctionToolParam{
				Name:        tool.Name,
				Description: param.NewOpt(tool.Description),
				Parameters:  parameters,
			}})
		}
		body.ToolChoice = responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: param.NewOpt(responses.ToolChoiceOptionsAuto)}
	}

	if len(p.baseItems) == 0 && (len(req.Messages) > 0 || req.System != "") {
		p.baseItems = p.baseInputItems(req)
	}
	if p.step == 0 && req.PreviousResponseID == "" && !p.opts.ReplayOutputItems {
		// 首步：system + transcript。
		items := make([]responses.ResponseInputItemUnionParam, 0, len(p.baseItems))
		for _, item := range p.baseItems {
			items = append(items, param.Override[responses.ResponseInputItemUnionParam](item))
		}
		body.Input = responses.ResponseNewParamsInputUnion{OfInputItemList: items}
		return body, nil
	}

	if p.opts.ReplayOutputItems {
		items := make([]responses.ResponseInputItemUnionParam, 0, len(p.baseItems)+len(req.FunctionOutputs)+len(p.replayItems))
		for _, item := range p.baseItems {
			items = append(items, param.Override[responses.ResponseInputItemUnionParam](item))
		}
		for _, item := range p.replayItems {
			items = append(items, param.Override[responses.ResponseInputItemUnionParam](item))
		}
		for _, output := range req.FunctionOutputs {
			items = append(items, param.Override[responses.ResponseInputItemUnionParam](json.RawMessage(jsonString(map[string]any{
				"type":    "function_call_output",
				"call_id": output.CallID,
				"output":  output.Output,
			}))))
		}
		body.Input = responses.ResponseNewParamsInputUnion{OfInputItemList: items}
		return body, nil
	}

	// 默认续轮：system 走 instructions（previous_response_id 下 system 不继承），
	// input 只带本步的 function outputs。
	if req.System != "" {
		body.Instructions = param.NewOpt(req.System)
	}
	items := make([]responses.ResponseInputItemUnionParam, 0, len(req.FunctionOutputs))
	for _, output := range req.FunctionOutputs {
		items = append(items, param.Override[responses.ResponseInputItemUnionParam](json.RawMessage(jsonString(map[string]any{
			"type":    "function_call_output",
			"call_id": output.CallID,
			"output":  output.Output,
		}))))
	}
	body.Input = responses.ResponseNewParamsInputUnion{OfInputItemList: items}
	previous := req.PreviousResponseID
	if previous == "" {
		previous = p.prevID
	}
	if previous != "" {
		body.PreviousResponseID = param.NewOpt(previous)
	}
	return body, nil
}

// baseInputItems 把首步的 system + transcript 冻结成 input items 原始 JSON，
// items 回放续轮时逐条重发（不重算，避免路由语义漂移）。
func (p *responsesStepProvider) baseInputItems(req StepRequest) []json.RawMessage {
	items := make([]json.RawMessage, 0, len(req.Messages)+1)
	if req.System != "" {
		items = append(items, json.RawMessage(jsonString(map[string]any{
			"role":    "system",
			"content": req.System,
		})))
	}
	for _, message := range req.Messages {
		items = append(items, responsesMessageRaw(message))
	}
	return items
}

// responsesMessageRaw 把一条纯文本 transcript 消息转成 Responses 的 input item JSON。
//
// user → content: [{type:"input_text", text}]；assistant → [{type:"output_text", text}]，
// 与 @ai-sdk/openai 的 convertToOpenAIResponsesInput 输出一致。
func responsesMessageRaw(message TranscriptMessage) json.RawMessage {
	partType := "input_text"
	role := "user"
	if message.Role == "assistant" {
		partType = "output_text"
		role = "assistant"
	}
	return json.RawMessage(jsonString(map[string]any{
		"role": role,
		"content": []map[string]any{{
			"type": partType,
			"text": message.Text,
		}},
	}))
}

// outputItemsRaw 从 response.completed 事件的原始 JSON 里取 output items。
func outputItemsRaw(eventRaw string) []json.RawMessage {
	var parsed struct {
		Response struct {
			Output []json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if err := json.Unmarshal([]byte(eventRaw), &parsed); err != nil {
		return nil
	}
	return parsed.Response.Output
}

// createdResponseID 从 response.created 事件里取 response id。
func createdResponseID(event responses.ResponseStreamEventUnion) string {
	var parsed struct {
		Response struct {
			ID string `json:"id"`
		} `json:"response"`
	}
	if err := json.Unmarshal([]byte(event.RawJSON()), &parsed); err != nil {
		return ""
	}
	return parsed.Response.ID
}

// isOpenAIReasoningModel 复刻 @ai-sdk/openai 的 getOpenAILanguageModelCapabilities
// 里 isReasoningModel 的判定（模型名前缀规则）；该分支下 temperature 与
// max_tokens 都不发。
func isOpenAIReasoningModel(model string) bool {
	switch {
	case strings.HasPrefix(model, "o1"), strings.HasPrefix(model, "o3"), strings.HasPrefix(model, "o4-mini"):
		return true
	case strings.HasPrefix(model, "gpt-5") && !strings.HasPrefix(model, "gpt-5-chat"):
		return true
	}
	return false
}

// traceRequestOptions 把 trace 头挂到 openai-go 请求上（provider.ts 的 withTraceHeaders）。
func traceRequestOptions(ctx context.Context) []option.RequestOption {
	headers := traceHeaders(ctx)
	if len(headers) == 0 {
		return nil
	}
	return []option.RequestOption{option.WithMiddleware(func(r *http.Request, next option.MiddlewareNext) (*http.Response, error) {
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		return next(r)
	})}
}
