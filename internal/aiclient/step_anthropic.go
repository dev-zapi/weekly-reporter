package aiclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
	"github.com/anthropics/anthropic-sdk-go/v2/packages/param"
)

// anthropicStepProvider 是 anthropic 协议的流式 adapter（anthropic-sdk-go v2
// Beta.Messages.NewStreaming + Accumulate）。
//
// 每个生成轮次一个实例：跨步的 assistant turn / tool_result 由它自己按步累积，
// 与 @ai-sdk/anthropic 在 streamText 内部维护的多步 prompt 等价。
type anthropicStepProvider struct {
	cfg   Config
	tools []Tool

	// messages 是当前轮次的 anthropic 原生消息列表：transcript、此前各步的
	// assistant turn 与 tool_result user 消息都按顺序追加。
	messages []anthropic.BetaMessageParam
	started  bool
	// assistant 是上一步 Accumulate 出来的 assistant message（下一步开头回放）。
	assistant *anthropic.BetaMessage
}

// anthropicPendingBlock 跟踪一个 tool_use 块的入参增量。
type anthropicPendingBlock struct {
	id   string
	name string
	args strings.Builder
}

// RunStep 实现 StepProvider。
func (p *anthropicStepProvider) RunStep(ctx context.Context, req StepRequest, emit func(Event) error) (*StepResult, error) {
	if err := p.extendMessages(req); err != nil {
		return nil, err
	}

	params, opts, err := p.buildRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	client := anthropic.NewClient(opts...)
	stream := client.Beta.Messages.NewStreaming(ctx, params)
	defer stream.Close()

	accumulated := anthropic.BetaMessage{}
	pending := map[int64]*anthropicPendingBlock{}
	var order []int64
	var toolCalls []StepToolCall

	flushToolCall := func(index int64, overrideInput string) error {
		block := pending[index]
		if block == nil {
			return nil
		}
		delete(pending, index)
		input := overrideInput
		if input == "" {
			input = block.args.String()
		}
		if input == "" {
			// AI SDK：tool_use 的入参为空串时按 "{}" 收尾。
			input = "{}"
		}
		toolCalls = append(toolCalls, StepToolCall{ID: block.id, Name: block.name, Input: input})
		return emit(Event{Kind: EventToolCall, ToolCallID: block.id, ToolName: block.name, Input: input})
	}

	for stream.Next() {
		event := stream.Current()
		if err := accumulated.Accumulate(event); err != nil {
			return nil, err
		}

		switch event.Type {
		case "message_start":
			// prefilled tool_use 块（罕见）：AI SDK 会立刻补发 start/delta/call。
			for _, block := range event.Message.Content {
				if block.Type != "tool_use" {
					continue
				}
				input := nonEmptyInputJSON(block.Input)
				if err := emit(Event{Kind: EventToolInputStart, ToolCallID: block.ID, ToolName: block.Name}); err != nil {
					return nil, err
				}
				if input != "" {
					if err := emit(Event{Kind: EventToolInputDelta, ToolCallID: block.ID, ToolName: block.Name}); err != nil {
						return nil, err
					}
				}
				input = inputOrEmptyObject(input)
				toolCalls = append(toolCalls, StepToolCall{ID: block.ID, Name: block.Name, Input: input})
				if err := emit(Event{Kind: EventToolCall, ToolCallID: block.ID, ToolName: block.Name, Input: input}); err != nil {
					return nil, err
				}
			}

		case "content_block_start":
			block := event.ContentBlock
			if block.Type == "tool_use" {
				pending[event.Index] = &anthropicPendingBlock{id: block.ID, name: block.Name}
				order = append(order, event.Index)
				if err := emit(Event{Kind: EventToolInputStart, ToolCallID: block.ID, ToolName: block.Name}); err != nil {
					return nil, err
				}
				// content_block_start 里若带了非空入参，先落进缓冲（AI SDK 同款）。
				if initial := nonEmptyInputJSON(block.Input); initial != "" {
					pending[event.Index].args.WriteString(initial)
				}
			}

		case "content_block_delta":
			switch event.Delta.Type {
			case "text_delta":
				if err := emit(Event{Kind: EventTextDelta, Text: event.Delta.Text}); err != nil {
					return nil, err
				}
			case "thinking_delta":
				if err := emit(Event{Kind: EventReasoningDelta, Text: event.Delta.Thinking}); err != nil {
					return nil, err
				}
			case "signature_delta":
				// thinking 签名只用于 assistant turn 回放，不产生增量。
			case "input_json_delta":
				block := pending[event.Index]
				if block != nil {
					block.args.WriteString(event.Delta.PartialJSON)
					if err := emit(Event{Kind: EventToolInputDelta, ToolCallID: block.id, ToolName: block.name}); err != nil {
						return nil, err
					}
				}
			}

		case "content_block_stop":
			if err := flushToolCall(event.Index, ""); err != nil {
				return nil, err
			}
		}
	}
	if err := stream.Err(); err != nil {
		return nil, streamError(ctx, err)
	}

	// 兜底：流结束仍未收到 content_block_stop 的 tool_use 块也要按序收尾。
	for _, index := range order {
		if err := flushToolCall(index, ""); err != nil {
			return nil, err
		}
	}

	p.assistant = &accumulated

	return &StepResult{ToolCalls: toolCalls, ResponseID: accumulated.ID}, nil
}

// extendMessages 把本步的输入追加进当前轮次的消息列表。
func (p *anthropicStepProvider) extendMessages(req StepRequest) error {
	if !p.started {
		p.started = true
		for _, message := range req.Messages {
			p.messages = append(p.messages, anthropicTranscriptMessage(message))
		}
		return nil
	}
	if len(req.FunctionOutputs) == 0 {
		return nil
	}
	// 续轮：先回放上一步的 assistant turn，再把全部 tool_result 放进同一条 user 消息。
	if p.assistant != nil {
		p.messages = append(p.messages, p.assistant.ToParam())
		p.assistant = nil
	}
	blocks := make([]anthropic.BetaContentBlockParamUnion, 0, len(req.FunctionOutputs))
	for _, output := range req.FunctionOutputs {
		// 与 @ai-sdk/anthropic 同形：content 是纯字符串、is_error 省略（false）。
		blocks = append(blocks, param.Override[anthropic.BetaContentBlockParamUnion](json.RawMessage(jsonString(map[string]any{
			"type":        "tool_result",
			"tool_use_id": output.CallID,
			"content":     output.Output,
		}))))
	}
	p.messages = append(p.messages, anthropic.NewBetaUserMessage(blocks...))
	return nil
}

// buildRequest 组装本步的 anthropic 请求。
func (p *anthropicStepProvider) buildRequest(ctx context.Context, req StepRequest) (anthropic.BetaMessageNewParams, []option.RequestOption, error) {
	base, err := (&Client{cfg: p.cfg}).anthropicBaseURL()
	if err != nil {
		return anthropic.BetaMessageNewParams{}, nil, err
	}
	// SDK 固定请求 "v1/messages"（相对 base 解析），和 provider.ts 的
	// `${baseURL}/messages` 对自定义前缀不等价；这里用 middleware 钉死最终 URL，
	// 保持与 TS 完全一致的请求路径。
	target, err := url.Parse(base + "/messages")
	if err != nil {
		return anthropic.BetaMessageNewParams{}, nil, err
	}
	origin, err := url.Parse(base)
	if err != nil {
		return anthropic.BetaMessageNewParams{}, nil, err
	}
	origin.Path = ""
	origin.RawQuery = ""
	origin.Fragment = ""

	params := anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(p.cfg.Model),
		MaxTokens: req.MaxOutputTokens,
		Messages:  p.messages,
	}
	if req.System != "" {
		params.System = []anthropic.BetaTextBlockParam{{Text: req.System}}
	}

	capabilities := anthropicCapabilitiesFor(p.cfg.Model)
	// 该版本 SDK 的参数结构对齐 2026-10-21 API，已不暴露 temperature；ADR-0027
	// 要求用 2023-06-01 保留采样参数，因此这里在序列化后的 body 上补写。
	var samplingOptions []option.RequestOption
	if !capabilities.rejectsSamplingParameters {
		if value, isNull := temperatureJSON(req.Temperature); isNull {
			// JSON.stringify(NaN) === null
			samplingOptions = append(samplingOptions, option.WithJSONSet("temperature", nil))
		} else {
			samplingOptions = append(samplingOptions, option.WithJSONSet("temperature", clampTemperature(value.(float64), 0, 1)))
		}
	}

	if len(p.tools) > 0 {
		params.Tools = make([]anthropic.BetaToolUnionParam, 0, len(p.tools))
		for _, tool := range p.tools {
			params.Tools = append(params.Tools, anthropic.BetaToolUnionParam{OfTool: &anthropic.BetaToolParam{
				Name:                tool.Name,
				Description:         param.NewOpt(tool.Description),
				InputSchema:         param.Override[anthropic.BetaToolInputSchemaParam](tool.Parameters),
				EagerInputStreaming: param.NewOpt(true),
			}})
		}
		params.ToolChoice = anthropic.BetaToolChoiceUnionParam{OfAuto: &anthropic.BetaToolChoiceAutoParam{}}
		if capabilities.supportsStructuredOutput {
			// @ai-sdk/anthropic 在 prepareTools 里对支持结构化输出的模型加该 beta。
			params.Betas = []anthropic.AnthropicBeta{anthropic.AnthropicBetaStructuredOutputs2025_11_13}
		}
	}

	opts := []option.RequestOption{
		// 不读 ANTHROPIC_* 环境变量：凭据与 baseURL 只来自 ai_config
		// （provider.ts 只透传 config.apiKey/apiUrl）。
		option.WithoutEnvironmentDefaults(),
		// API key 走 x-api-key（provider.ts 的同款头）；该 SDK 的 WithAPIKey
		// 只写 Authorization: Bearer，因此这里显式设头。
		option.WithHeader("x-api-key", p.cfg.APIKey),
		option.WithBaseURL(origin.String()),
		// 钉回 2023-06-01：SDK 默认 2026-10-21 会拒绝 temperature/top_p/top_k。
		option.WithHeader("anthropic-version", anthropicVersion),
		option.WithMiddleware(func(r *http.Request, next option.MiddlewareNext) (*http.Response, error) {
			r.URL = target
			return next(r)
		}),
	}
	for key, value := range traceHeaders(ctx) {
		opts = append(opts, option.WithHeader(key, value))
	}
	opts = append(opts, samplingOptions...)
	return params, opts, nil
}

// anthropicTranscriptMessage 把一条纯文本 transcript 消息转成 anthropic 参数形态。
func anthropicTranscriptMessage(message TranscriptMessage) anthropic.BetaMessageParam {
	if message.Role == "assistant" {
		return anthropic.BetaMessageParam{OfAssistant: &anthropic.BetaAssistantMessageParam{
			Content: []anthropic.BetaContentBlockParamUnion{anthropic.NewBetaTextBlock(message.Text)},
		}}
	}
	return anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(message.Text))
}

// inputOrEmptyObject 复刻 AI SDK 对空 tool input 的兜底（"" → "{}"）。
func inputOrEmptyObject(input string) string {
	if input == "" {
		return "{}"
	}
	return input
}

// streamError 把流错误归一化：ctx 取消优先返回 ctx.Err()。
func streamError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
