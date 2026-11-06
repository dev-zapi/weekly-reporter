package aiclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// compatStepProvider 是 openai-compatible（Chat Completions）协议的流式 adapter。
//
// ADR-0027 要求这条路径**裸 SSE 直读**、不移植 AI SDK 的 reasoning 标记 hack：
// delta 里的 reasoning_content / reasoning / thinking 直接映射成 reasoning-delta，
// content 映射成 text-delta；请求仍然 POST /chat/completions，消息历史形状
// （user instruction 文本 + assistant tool_calls 回放）与 e2e scripted-AI 的
// marker 协议保持一致。
type compatStepProvider struct {
	cfg   Config
	tools []Tool
	// messages 是本轮次累积的 chat-completions 消息（system / transcript /
	// assistant tool_calls / tool 结果），每步直接发送。
	messages []map[string]any
	started  bool
}

// compatToolCall 跟踪一个流式 tool_call 的入参增量。
type compatToolCall struct {
	id   string
	name string
	args strings.Builder
}

// RunStep 实现 StepProvider。
func (p *compatStepProvider) RunStep(ctx context.Context, req StepRequest, emit func(Event) error) (*StepResult, error) {
	p.extendMessages(req)

	body, err := p.buildRequest(req)
	if err != nil {
		return nil, err
	}
	base, err := (&Client{cfg: p.cfg}).baseURL(defaultOpenAIBaseURL)
	if err != nil {
		return nil, err
	}

	res, err := p.postStream(ctx, base+"/chat/completions", body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	result := &StepResult{}
	var text strings.Builder
	pending := map[int64]*compatToolCall{}
	var order []int64

	if err := p.consumeSSE(ctx, res.Body, emit, result, pending, &order, &text); err != nil {
		return nil, err
	}

	// 流结束时收尾所有未完成的 tool call（AI SDK StreamingToolCallTracker.flush）。
	for _, index := range order {
		call := pending[index]
		if call == nil {
			continue
		}
		input := call.args.String()
		result.ToolCalls = append(result.ToolCalls, StepToolCall{ID: call.id, Name: call.name, Input: input})
		if err := emit(Event{Kind: EventToolCall, ToolCallID: call.id, ToolName: call.name, Input: input}); err != nil {
			return nil, err
		}
	}

	// 把本步的 assistant 消息（文本 + tool_calls）写回历史，供下一步回放。
	assistant := map[string]any{"role": "assistant"}
	if text.Len() > 0 || len(result.ToolCalls) == 0 {
		assistant["content"] = text.String()
	} else {
		assistant["content"] = nil
	}
	if len(result.ToolCalls) > 0 {
		calls := make([]map[string]any, 0, len(result.ToolCalls))
		for _, call := range result.ToolCalls {
			calls = append(calls, map[string]any{
				"id":   call.ID,
				"type": "function",
				"function": map[string]any{
					"name":      call.Name,
					"arguments": call.Input,
				},
			})
		}
		assistant["tool_calls"] = calls
	}
	p.messages = append(p.messages, assistant)
	return result, nil
}

// extendMessages 组装本步发送的消息列表。
func (p *compatStepProvider) extendMessages(req StepRequest) {
	if !p.started {
		p.started = true
		if req.System != "" {
			p.messages = append(p.messages, map[string]any{"role": openaiSystemRole(p.cfg.Model), "content": req.System})
		}
		for _, message := range req.Messages {
			p.messages = append(p.messages, map[string]any{"role": message.Role, "content": message.Text})
		}
		return
	}
	// 续轮：assistant(tool_calls) 已在上一步末尾追加；这里补 tool 结果消息。
	for _, output := range req.FunctionOutputs {
		p.messages = append(p.messages, map[string]any{
			"role":         "tool",
			"tool_call_id": output.CallID,
			"content":      output.Output,
		})
	}
}

// buildRequest 组装 Chat Completions 请求体，形状与 @ai-sdk/openai 的 chat()
// 请求一致（字段取值见 dist 的 getArgs）。
func (p *compatStepProvider) buildRequest(req StepRequest) (map[string]any, error) {
	body := map[string]any{
		"model":    p.cfg.Model,
		"messages": p.messages,
		"stream":   true,
		"stream_options": map[string]any{
			"include_usage": true,
		},
	}
	reasoning := isOpenAIReasoningModel(p.cfg.Model)
	if reasoning {
		// 推理模型用 max_completion_tokens，且不接受采样参数。
		if req.MaxOutputTokens > 0 {
			body["max_completion_tokens"] = req.MaxOutputTokens
		}
	} else {
		if req.MaxOutputTokens > 0 {
			body["max_tokens"] = req.MaxOutputTokens
		}
		setTemperature(body, req.Temperature)
	}

	if len(p.tools) > 0 {
		tools := make([]map[string]any, 0, len(p.tools))
		for _, tool := range p.tools {
			var parameters any = map[string]any{}
			if len(tool.Parameters) > 0 {
				if err := json.Unmarshal(tool.Parameters, &parameters); err != nil {
					return nil, err
				}
			}
			tools = append(tools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        tool.Name,
					"description": tool.Description,
					"parameters":  parameters,
				},
			})
		}
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	return body, nil
}

// postStream 发一个流式请求，复刻 AI SDK 的重试语义：408/409/429/5xx 与网络
// 错误最多重试 maxRetries 次（流一旦开始就不再重试），其余错误直接返回。
func (p *compatStepProvider) postStream(ctx context.Context, url string, body map[string]any) (*http.Response, error) {
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
		res, err := p.openStream(ctx, url, payload)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if !isRetryable(ctx, err) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("Failed after %d attempts. Last error: %w", maxRetries+1, lastErr)
}

// openStream 发一次请求（不含重试）。
func (p *compatStepProvider) openStream(ctx context.Context, url string, payload []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errInvalidRequest, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	for key, value := range traceHeaders(ctx) {
		req.Header.Set(key, value)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		raw, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		retryAfter, hasRetryAfter := parseRetryAfter(res.Header)
		return nil, &StatusError{
			StatusCode:    res.StatusCode,
			Body:          string(raw),
			RetryAfter:    retryAfter,
			RetryAfterSet: hasRetryAfter,
		}
	}
	return res, nil
}

// consumeSSE 按 SSE 规范逐事件解析（空行派发，多行 data 以 \n 拼接），把
// Chat Completions 的 delta 归一化成引擎事件。
func (p *compatStepProvider) consumeSSE(
	ctx context.Context,
	body io.Reader,
	emit func(Event) error,
	result *StepResult,
	pending map[int64]*compatToolCall,
	order *[]int64,
	text *strings.Builder,
) error {
	scanner := bufio.NewScanner(body)
	// tool 入参可能是很大的 JSON（正文候选最长 200k），放大 token 上限。
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var data []string
	dispatch := func() error {
		if len(data) == 0 {
			return nil
		}
		payload := strings.Join(data, "\n")
		data = nil
		if strings.TrimSpace(payload) == "[DONE]" {
			return errSSEDone
		}
		return p.handleChunk(payload, emit, pending, order, text)
	}

	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			if err := dispatch(); err != nil {
				if errors.Is(err, errSSEDone) {
					return nil
				}
				return err
			}
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		default:
			// event: / id: / retry: / 注释行与本协议无关。
		}
	}
	if err := scanner.Err(); err != nil {
		return streamError(ctx, err)
	}
	if err := dispatch(); err != nil && !errors.Is(err, errSSEDone) {
		return err
	}
	return nil
}

// errSSEDone 是 data: [DONE] 的内部控制流哨兵。
var errSSEDone = errors.New("aiclient: sse done")

// handleChunk 解析一条 Chat Completions SSE 数据并派发事件。
func (p *compatStepProvider) handleChunk(
	payload string,
	emit func(Event) error,
	pending map[int64]*compatToolCall,
	order *[]int64,
	text *strings.Builder,
) error {
	var chunk struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Choices []struct {
			Delta struct {
				Content          *string `json:"content"`
				ReasoningContent *string `json:"reasoning_content"`
				Reasoning        *string `json:"reasoning"`
				Thinking         *string `json:"thinking"`
				ToolCalls        []struct {
					Index    *int64 `json:"index"`
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return err
	}
	if chunk.Error != nil {
		return fmt.Errorf("stream error: %s", chunk.Error.Message)
	}
	if len(chunk.Choices) == 0 {
		return nil
	}
	delta := chunk.Choices[0].Delta

	// 先 reasoning、后 text（与旧 marker hack 的拆分顺序一致）。
	for _, reasoning := range []*string{delta.ReasoningContent, delta.Reasoning, delta.Thinking} {
		if reasoning != nil && *reasoning != "" {
			if err := emit(Event{Kind: EventReasoningDelta, Text: *reasoning}); err != nil {
				return err
			}
			break
		}
	}
	if delta.Content != nil && *delta.Content != "" {
		text.WriteString(*delta.Content)
		if err := emit(Event{Kind: EventTextDelta, Text: *delta.Content}); err != nil {
			return err
		}
	}

	for _, deltaCall := range delta.ToolCalls {
		index := int64(len(*order))
		if deltaCall.Index != nil {
			index = *deltaCall.Index
		}
		call, seen := pending[index]
		if !seen {
			if deltaCall.Type != "" && deltaCall.Type != "function" {
				return fmt.Errorf("invalid tool call delta: expected function type, got %q", deltaCall.Type)
			}
			if deltaCall.ID == "" || deltaCall.Function.Name == "" {
				return fmt.Errorf("invalid tool call delta: missing id or name")
			}
			call = &compatToolCall{id: deltaCall.ID, name: deltaCall.Function.Name}
			pending[index] = call
			*order = append(*order, index)
			if err := emit(Event{Kind: EventToolInputStart, ToolCallID: call.id, ToolName: call.name}); err != nil {
				return err
			}
		}
		if deltaCall.Function.Arguments != "" {
			call.args.WriteString(deltaCall.Function.Arguments)
			if err := emit(Event{Kind: EventToolInputDelta, ToolCallID: call.id, ToolName: call.name}); err != nil {
				return err
			}
		}
	}
	return nil
}

// openaiSystemRole 复刻 getOpenAILanguageModelCapabilities 的 systemMessageMode：
// 推理模型用 developer，其余用 system。
func openaiSystemRole(model string) string {
	if isOpenAIReasoningModel(model) {
		return "developer"
	}
	return "system"
}
