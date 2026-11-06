package aiclient

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// 本文件是 ADR-0027 定型的流式 adapter 面：一个生成轮次由 StepProvider 承载，
// 每一步（step）调用 RunStep 发一次模型请求，把 provider 原生事件归一化成
// Event，并把本步的 tool calls / provider 侧续轮状态带给引擎。
//
// 与垂直切片（prototype/go-gen-engine/provider.go）的对应关系：
//   - stepRequest  → StepRequest（字段逐一对应）
//   - stepResult   → StepResult
//   - runStep      → RunStep
//   - providerEvent→ Event（Kind 0..4 语义一致）
//
// 续轮状态（responses 的 previous_response_id / anthropic 的 assistant turn /
// compat 的 assistant tool_calls 回放）属于 provider 私有细节，由 StepProvider
// 实例自己持有：一个 StepProvider 只服务一个生成轮次，必须按步顺序串行调用。
// 这与垂直切片里「每个轮次 new 一个 provider」的用法一致。

// EventKind 是归一化事件类型，数值与垂直切片 providerEvent.kind 一致。
type EventKind int

const (
	// EventReasoningDelta 是 reasoning / thinking 文本增量。
	EventReasoningDelta EventKind = iota
	// EventTextDelta 是可见文本增量。
	EventTextDelta
	// EventToolInputStart 表示模型开始一个工具调用（CallID + ToolName 可用）。
	EventToolInputStart
	// EventToolInputDelta 表示工具调用入参仍在流式生成（本域 wire 只需 ToolName）。
	EventToolInputDelta
	// EventToolCall 表示一个工具调用已完成，Input 是完整 JSON 字符串。
	EventToolCall
)

// Event 是 RunStep 通过 emit 回调交给引擎的一条归一化事件。
type Event struct {
	Kind       EventKind
	Text       string
	ToolCallID string
	ToolName   string
	// Input 仅 EventToolCall 有值：模型给出的完整入参 JSON 字符串（可能是 ""）。
	Input string
}

// TranscriptMessage 是跨轮 transcript 的一条纯文本消息（user / assistant）。
type TranscriptMessage struct {
	Role string
	Text string
}

// FunctionOutputItem 是上一步某个工具调用的执行结果，用于续轮回放。
type FunctionOutputItem struct {
	CallID string
	Name   string
	Output string // JSON 字符串
}

// StepToolCall 是模型请求的一次工具调用。
type StepToolCall struct {
	ID    string
	Name  string
	Input string // 原始 JSON 字符串（可能是 ""）
}

// Tool 是一个函数工具定义。Parameters 是 JSON Schema 对象（调用方负责给出
// 与 AI SDK 等价的 schema，含 additionalProperties:false 与 required）。
type Tool struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

// StepRequest 是一次模型调用（垂直切片 stepRequest 的导出形式）。
type StepRequest struct {
	System          string
	Messages        []TranscriptMessage
	FunctionOutputs []FunctionOutputItem
	Temperature     float64
	MaxOutputTokens int64
	// PreviousResponseID 由引擎从上一步 StepResult.ResponseID 透传；responses
	// 适配器默认用它链式续轮。为空时按首步处理。
	PreviousResponseID string
}

// StepResult 是一次模型调用的结果（垂直切片 stepResult 的导出形式）。
type StepResult struct {
	ToolCalls  []StepToolCall
	ResponseID string
}

// StepProvider 是一个生成轮次的三协议流式适配器。
//
// 用法：一个轮次创建一个 StepProvider，然后按步顺序调用 RunStep：
// 第一步用 req.Messages 发 transcript，后续步只带 req.FunctionOutputs
// （续轮所需的 assistant turn / response id 由适配器自己保存）。
//
// emit 返回错误时 RunStep 会立即终止并把该错误返回（通常代表客户端已断开）。
type StepProvider interface {
	RunStep(ctx context.Context, req StepRequest, emit func(Event) error) (*StepResult, error)
}

// NewStepProvider 按 ai_config.protocol 选择适配器。
//
// protocol 的选择与 provider.ts 的 createModelFromConfig 一致：
//   - "anthropic"         → Anthropic Messages API
//   - "openai-compatible" → OpenAI Chat Completions（兼容代理，裸 SSE）
//   - 其它（含 "openai"） → OpenAI Responses API
//
// tools 是本轮提供给模型的全部函数工具，每步都会随请求发送。
// opts 只影响 responses 协议的续轮形态（items 回放开关，默认关）。
func NewStepProvider(cfg Config, tools []Tool, opts ...StepOption) StepProvider {
	var settled StepOptions
	for _, opt := range opts {
		opt(&settled)
	}
	switch cfg.Protocol {
	case ProtocolAnthropic:
		return &anthropicStepProvider{cfg: cfg, tools: tools}
	case ProtocolOpenAICompatible:
		return &compatStepProvider{cfg: cfg, tools: tools}
	default:
		return &responsesStepProvider{cfg: cfg, tools: tools, opts: settled}
	}
}

// StepOptions 是适配器的实现开关（ADR-0027「实现开关，配置或探测切换」）。
type StepOptions struct {
	// ReplayOutputItems 打开后，responses 协议不再用 previous_response_id 续轮，
	// 而是把 transcript + 上一步完整 output items + function outputs 全量回放。
	// 供不持状态的兼容代理使用（风险登记 #2）；默认关。
	ReplayOutputItems bool
}

// StepOption 是 StepOptions 的函数式选项。
type StepOption func(*StepOptions)

// WithReplayOutputItems 打开 responses 协议的 items 回放续轮。
func WithReplayOutputItems(replay bool) StepOption {
	return func(opts *StepOptions) { opts.ReplayOutputItems = replay }
}

// traceHeaders 复刻 provider.ts 的 withTraceHeaders：出站调用带 traceparent +
// x-trace-id；没有 trace 上下文时返回 nil。
func traceHeaders(ctx context.Context) map[string]string {
	tc, ok := trace.FromContext(ctx)
	if !ok {
		return nil
	}
	return map[string]string{
		"traceparent": trace.TraceParent(tc.TraceID, tc.SpanID),
		"x-trace-id":  tc.TraceID,
	}
}

// temperatureJSON 复刻 AI SDK 的 JSON.stringify 语义：NaN 序列化为 null。
// 返回 (值, 是否显式 null)。
func temperatureJSON(temperature float64) (any, bool) {
	if math.IsNaN(temperature) {
		return nil, true
	}
	return temperature, false
}

// jsonString 是 json.Marshal 的便捷包装，仅供 adapter 内部拼原始 JSON 使用。
func jsonString(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// nonEmptyInputJSON 返回非空对象形态的入参 JSON；空 / null / {} 一律返回 ""。
// anthropic content_block_start 里的 input 是 any（空对象会被解成 map）。
func nonEmptyInputJSON(input any) string {
	if input == nil {
		return ""
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" || text == "{}" {
		return ""
	}
	return text
}
