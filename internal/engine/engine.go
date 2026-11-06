// Package engine 实现 ADR-0027 定型的生成引擎：多步 tool-loop、10 种 NDJSON
// 线事件、500ms 节流落库、停止注册表与断连/失败收尾。
//
// 行为唯一事实源是 src/lib/generation/stream.ts 与 service.ts；provider 传输由
// internal/aiclient 的三协议 step adapter 承担，本包只拥有循环与持久化副作用。
package engine

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/engine/tools"
	"github.com/dev-zapi/weekly-reporter/internal/generation"
)

const (
	contextCharacterLimit = 450_000
	maxOutputTokens       = 16_000
	maxSteps              = 6
	flushIntervalMillis   = 500
	errorClientGone       = "client disconnected"
)

var errClientGone = errors.New(errorClientGone)

// ProviderFactory 按 ai_config 建一个轮次专用的 StepProvider。测试用它注入
// mock provider；生产默认是 aiclient.NewStepProvider。
type ProviderFactory func(cfg aiclient.Config, tools []aiclient.Tool, opts ...aiclient.StepOption) aiclient.StepProvider

// Options 装配引擎。
type Options struct {
	Queries *db.Queries
	// NewProvider 为 nil 时走 aiclient 三协议 adapter。
	NewProvider ProviderFactory
	// Now 为 nil 时用 time.Now；测试用它驱动 500ms 节流。
	Now func() time.Time
	// ReplayOutputItems 打开 responses 协议的完整 items 回放（风险登记 #2，默认关）。
	ReplayOutputItems bool
}

// Engine 持有本进程内所有活跃轮次的停止注册表。
type Engine struct {
	Queries           *db.Queries
	Registry          *Registry
	newProvider       ProviderFactory
	now               func() time.Time
	replayOutputItems bool
}

// New 创建引擎。
func New(opts Options) *Engine {
	provider := opts.NewProvider
	if provider == nil {
		provider = aiclient.NewStepProvider
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Engine{
		Queries:           opts.Queries,
		Registry:          NewRegistry(),
		newProvider:       provider,
		now:               now,
		replayOutputItems: opts.ReplayOutputItems,
	}
}

// Registry 是模块级 Map<turnId, AbortController> 的 Go 对应物。
type Registry struct {
	mu      sync.Mutex
	cancels map[int64]context.CancelFunc
}

// NewRegistry 返回空注册表。
func NewRegistry() *Registry {
	return &Registry{cancels: make(map[int64]context.CancelFunc)}
}

func (r *Registry) set(turnID int64, cancel context.CancelFunc) {
	r.mu.Lock()
	r.cancels[turnID] = cancel
	r.mu.Unlock()
}

func (r *Registry) delete(turnID int64) {
	r.mu.Lock()
	delete(r.cancels, turnID)
	r.mu.Unlock()
}

// stop 取消活跃轮次；返回是否找到 controller（与 stopGenerationTurn 的返回值
// 同义，markTurnStopped 不使用它）。
func (r *Registry) stop(turnID int64) bool {
	r.mu.Lock()
	cancel := r.cancels[turnID]
	r.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

// PreparedTurn 是 prepareGenerationTurn 的产物。
type PreparedTurn struct {
	Detail *sessionDetail
	Config aiConfig
	Report db.Report
	Turn   *db.GenerationTurn
}

// PrepareTurn 复刻 prepareGenerationTurn：会话/版本/AI 配置/报告校验、450k
// UTF-16 上下文上限、启动轮次后重读详情。
func (e *Engine) PrepareTurn(ctx context.Context, reportID, sessionID int64, userMessage string) (*PreparedTurn, error) {
	// DB 收尾不跟随请求取消：客户端断连时 TS 仍会写库（ADR-0027）。
	dbCtx := context.WithoutCancel(ctx)

	detail, err := e.loadDetail(dbCtx, reportID, sessionID)
	if err != nil {
		return nil, err
	}
	if detail == nil {
		return nil, errSessionNotFound()
	}
	if !detail.SourceIsCurrent {
		return nil, errSourceRevisionConflict("The source draft has changed; start a new session from the latest draft")
	}
	config, err := e.loadAIConfig(dbCtx)
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, serviceError("AI_API_KEY 未配置", "AI_NOT_CONFIGURED", http.StatusBadRequest)
	}
	report, err := e.Queries.GetReportForReportRoutes(dbCtx, reportID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serviceError("周报不存在", "REPORT_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}

	transcriptCharacters := 0
	for _, part := range detail.Parts {
		if part.Content != nil {
			transcriptCharacters += jsstr.UTF16Len(*part.Content)
		}
		if len(part.Data) > 0 {
			transcriptCharacters += jsstr.UTF16Len(string(part.Data))
		}
	}
	latestProposalContent := ""
	if len(detail.Proposals) > 0 {
		latestProposalContent = detail.Proposals[len(detail.Proposals)-1].Content
	}
	baselineCharacters := 0
	if detail.Session.BaselineFinalContent != nil {
		baselineCharacters = jsstr.UTF16Len(*detail.Session.BaselineFinalContent)
	}
	contextCharacters := jsstr.UTF16Len(detail.Session.SourceDraftSnapshot) +
		jsstr.UTF16Len(detail.Session.TemplateContent) +
		jsstr.UTF16Len(detail.Session.SystemPrompt) +
		jsstr.UTF16Len(detail.Session.AiStylePrompt) +
		jsstr.UTF16Len(detail.Session.ToolRules) +
		baselineCharacters +
		jsstr.UTF16Len(latestProposalContent) +
		transcriptCharacters
	if contextCharacters > contextCharacterLimit {
		return nil, serviceError("会话上下文接近上限，请从当前终版创建新会话后继续。", "CONTEXT_LIMIT", http.StatusConflict)
	}

	turn, err := e.startGenerationTurn(dbCtx, &detail.Session, *config, userMessage)
	if err != nil {
		return nil, err
	}
	refreshed, err := e.loadDetail(dbCtx, reportID, sessionID)
	if err != nil {
		return nil, err
	}
	if refreshed == nil {
		return nil, errSessionNotFound()
	}
	return &PreparedTurn{Detail: refreshed, Config: *config, Report: report, Turn: turn}, nil
}

// StopTurn 复刻 markTurnStopped：轮次不存在 404；非 working 原样返回；否则取消
// 活跃 controller 后按 aborted 收尾。
func (e *Engine) StopTurn(ctx context.Context, turnID int64) (*db.GenerationTurn, error) {
	dbCtx := context.WithoutCancel(ctx)
	turn, err := e.Queries.GetGenerationTurnByIDForGenerationEngine(dbCtx, turnID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serviceError("生成轮次不存在", "TURN_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}
	if turn.Status != "working" {
		return &turn, nil
	}
	e.Registry.stop(turnID)
	return e.finishGenerationTurn(dbCtx, turnID, "aborted", nil)
}

// throttledPart 是「首个 delta 插入、之后每 ≥500ms 合并更新」的 part writer。
type throttledPart struct {
	engine    *Engine
	ctx       context.Context
	sessionID int64
	turnID    int64
	role      string
	partType  string
	eventType string
	partID    int64
	content   string
	lastFlush int64
	send      func(WireEvent) error
}

func (t *throttledPart) append(text string, nowMillis int64) error {
	if text == "" {
		return nil
	}
	t.content += text
	if t.partID == 0 {
		content := t.content
		id, err := t.engine.appendPart(t.ctx, t.sessionID, &t.turnID, t.role, t.partType, &content, nil)
		if err != nil {
			return err
		}
		t.partID = id
		t.lastFlush = nowMillis
	} else if err := t.flush(false, nowMillis); err != nil {
		return err
	}
	return t.send(WireEvent{Type: t.eventType, Text: &text})
}

func (t *throttledPart) flush(force bool, nowMillis int64) error {
	if t.partID == 0 {
		return nil
	}
	if !force && nowMillis-t.lastFlush < flushIntervalMillis {
		return nil
	}
	content := t.content
	if err := t.engine.Queries.UpdateGenerationMessagePartContentForGenerationEngine(t.ctx, db.UpdateGenerationMessagePartContentForGenerationEngineParams{
		Content: &content,
		ID:      t.partID,
	}); err != nil {
		return err
	}
	t.lastFlush = nowMillis
	return nil
}

// StreamTurn 是 createGenerationEventStream 的 Go 对应物：逐事件推 NDJSON 并
// 同步落库。返回前一定已经收尾轮次（completed / aborted / failed）。
func (e *Engine) StreamTurn(w http.ResponseWriter, r *http.Request, prepared *PreparedTurn) {
	storeCtx := context.WithoutCancel(r.Context())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	turnID := prepared.Turn.ID
	sessionID := prepared.Detail.Session.ID
	e.Registry.set(turnID, cancel)
	defer e.Registry.delete(turnID)

	// 客户端断连 → cancel（TS request.signal → AbortController）。done 让
	// goroutine 在正常结束时不悬挂。
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-r.Context().Done():
			cancel()
		case <-done:
		}
	}()

	flusher, _ := w.(http.Flusher)
	clientGone := false
	send := func(event WireEvent) error {
		if clientGone {
			return errClientGone
		}
		if _, err := w.Write(jsonLine(event)); err != nil {
			clientGone = true
			cancel()
			return errClientGone
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	nowMillis := func() int64 { return e.now().UnixMilli() }

	textWriter := &throttledPart{engine: e, ctx: storeCtx, sessionID: sessionID, turnID: turnID, role: "assistant", partType: "text", eventType: "text-delta", send: send}
	reasoningWriter := &throttledPart{engine: e, ctx: storeCtx, sessionID: sessionID, turnID: turnID, role: "assistant", partType: "reasoning", eventType: "reasoning-delta", send: send}

	pendingToolNames := map[string]string{}
	toolStartedAt := map[string]int64{}
	budget := toolBudget{}
	var proposal *proposalRecord

	appendPart := func(role, partType string, content *string, data any) error {
		_, err := e.appendPart(storeCtx, sessionID, &turnID, role, partType, content, data)
		return err
	}

	emit := func(event aiclient.Event) error {
		switch event.Kind {
		case aiclient.EventReasoningDelta:
			return reasoningWriter.append(event.Text, nowMillis())
		case aiclient.EventTextDelta:
			return textWriter.append(event.Text, nowMillis())
		case aiclient.EventToolInputStart:
			pendingToolNames[event.ToolCallID] = event.ToolName
			toolStartedAt[event.ToolCallID] = nowMillis()
			return nil
		case aiclient.EventToolInputDelta:
			name := pendingToolNames[event.ToolCallID]
			if name == "" {
				name = "tool"
			}
			return send(WireEvent{Type: "tool-input-delta", ToolName: &name})
		case aiclient.EventToolCall:
			content := "调用 propose_final_report 提交候选终版"
			switch event.ToolName {
			case reportListToolName:
				content = "调用 查询周报列表。历史参考·不可信。"
			case reportContentToolName:
				content = "调用 查询周报内容。历史参考·不可信。"
			}
			if err := appendPart("assistant", "tool-call", &content, map[string]any{
				"toolName": event.ToolName, "toolCallId": event.ToolCallID, "input": decodedInput(event.Input),
			}); err != nil {
				return err
			}
			name := event.ToolName
			callID := event.ToolCallID
			return send(WireEvent{Type: "tool-call", ToolName: &name, ToolCallID: &callID})
		}
		return nil
	}

	// writeToolResult：成功分支的 part + wire 事件（propose 额外发 proposal）。
	writeToolResult := func(call aiclient.StepToolCall, execution toolExecution) error {
		content := toolResultContent(call.Name, execution.Output, proposal)
		data := map[string]any{
			"toolName": call.Name, "toolCallId": call.ID, "output": execution.Output,
		}
		if call.Name == proposeToolName && proposal != nil {
			data["proposalId"] = proposal.ID
		}
		if err := appendPart("tool", "tool-result", &content, data); err != nil {
			return err
		}
		name, callID := call.Name, call.ID
		if err := send(WireEvent{Type: "tool-result", ToolName: &name, ToolCallID: &callID}); err != nil {
			return err
		}
		if call.Name == proposeToolName && proposal != nil {
			return send(WireEvent{Type: "proposal", Proposal: wireProposal(proposal)})
		}
		return nil
	}

	// writeToolError：AI SDK 的 tool-error part（data 带 input，续轮只发错误文本）。
	writeToolError := func(call aiclient.StepToolCall, execution toolExecution) error {
		if execution.Snapshot {
			started := toolStartedAt[call.ID]
			duration := int64(0)
			if started != 0 {
				duration = nowMillis() - started
			}
			e.persistQuerySnapshot(storeCtx, sessionID, call.Name, execution.Input, execution.Output, duration, "automatic", nil)
		}
		content := toolResultContent(call.Name, execution.Output, proposal)
		data := map[string]any{
			"toolName": call.Name, "toolCallId": call.ID,
			"input": execution.Input, "output": execution.Output,
		}
		if err := appendPart("tool", "tool-result", &content, data); err != nil {
			return err
		}
		name, callID := call.Name, call.ID
		return send(WireEvent{Type: "tool-result", ToolName: &name, ToolCallID: &callID})
	}

	finalStatus := "completed"
	fail := func(streamErr error) {
		_ = textWriter.flush(true, nowMillis())
		_ = reasoningWriter.flush(true, nowMillis())
		if ctx.Err() != nil || errors.Is(streamErr, context.Canceled) || errors.Is(streamErr, errClientGone) {
			finalStatus = "aborted"
			_, _ = e.finishGenerationTurn(storeCtx, turnID, "aborted", nil)
			_ = send(WireEvent{Type: "finish", Status: &finalStatus})
			return
		}
		message := streamErr.Error()
		_, _ = e.finishGenerationTurn(storeCtx, turnID, "failed", &message)
		_ = send(WireEvent{Type: "error", Message: &message})
	}

	runErr := func() error {
		protocol := prepared.Config.Protocol
		model := prepared.Config.Model
		if err := send(WireEvent{Type: "start", TurnID: &turnID, Protocol: &protocol, Model: &model}); err != nil {
			return err
		}
		workingLabel := "Working..."
		if err := send(WireEvent{Type: "working", Label: &workingLabel}); err != nil {
			return err
		}

		var latestProposal *string
		if len(prepared.Detail.Proposals) > 0 {
			content := prepared.Detail.Proposals[len(prepared.Detail.Proposals)-1].Content
			latestProposal = &content
		}
		system := generation.BuildModelSystemContext(generation.ModelSystemContextInput{
			SystemPrompt:                   prepared.Detail.Session.SystemPrompt,
			StylePrompt:                    prepared.Detail.Session.AiStylePrompt,
			ToolRules:                      prepared.Detail.Session.ToolRules,
			Variant:                        prepared.Detail.Session.Variant,
			WeekStart:                      prepared.Report.WeekStart,
			WeekEnd:                        prepared.Report.WeekEnd,
			TemplateName:                   prepared.Detail.Session.TemplateName,
			TemplateContent:                prepared.Detail.Session.TemplateContent,
			SourceDraft:                    prepared.Detail.Session.SourceDraftSnapshot,
			BaselineFinalContent:           prepared.Detail.Session.BaselineFinalContent,
			LatestProposalContent:          latestProposal,
			HistoricalReportListResults:    persistedResults(prepared.Detail.Parts, reportListToolName, tools.IsReportListToolResult),
			HistoricalReportContentResults: persistedResults(prepared.Detail.Parts, reportContentToolName, tools.IsReportContentToolResult),
		})

		messages := make([]aiclient.TranscriptMessage, 0)
		for _, part := range prepared.Detail.Parts {
			if part.PartType != "text" || part.Content == nil || *part.Content == "" {
				continue
			}
			switch part.Role {
			case "user":
				messages = append(messages, aiclient.TranscriptMessage{Role: "user", Text: *part.Content})
			case "assistant":
				messages = append(messages, aiclient.TranscriptMessage{Role: "assistant", Text: *part.Content})
			}
		}

		temperature, ok := jsnum.ParseFloat(prepared.Detail.Session.Temperature)
		if !ok {
			temperature = math.NaN()
		}

		providerOptions := make([]aiclient.StepOption, 0, 1)
		if e.replayOutputItems {
			providerOptions = append(providerOptions, aiclient.WithReplayOutputItems(true))
		}
		provider := e.newProvider(aiclient.Config{
			Protocol: prepared.Config.Protocol,
			BaseURL:  prepared.Config.BaseURL,
			APIKey:   prepared.Config.APIKey,
			Model:    prepared.Config.Model,
		}, toolDefinitions(), providerOptions...)

		request := aiclient.StepRequest{
			System:          system,
			Messages:        messages,
			Temperature:     temperature,
			MaxOutputTokens: maxOutputTokens,
		}

		for step := 1; ; step++ {
			result, err := provider.RunStep(ctx, request, emit)
			if err != nil {
				return err
			}

			requestedPropose := false
			outputs := make(map[string]string, len(result.ToolCalls))
			for _, call := range result.ToolCalls {
				if call.Name == proposeToolName {
					requestedPropose = true
				}
				execution := e.executeTool(storeCtx, &prepared.Detail.Session, turnID, call, &budget, proposal)
				if execution.ToolErrored {
					outputs[call.ID] = execution.ErrorMessage
					if err := writeToolError(call, execution); err != nil {
						return err
					}
					continue
				}
				if execution.Proposal != nil {
					proposal = execution.Proposal
				}
				if text, ok := marshalJSONText(execution.Output); ok {
					outputs[call.ID] = text
				} else {
					outputs[call.ID] = "{}"
				}
				if err := writeToolResult(call, execution); err != nil {
					return err
				}
			}

			// OR 语义，且在工具执行之后评估：请求了 propose、到第 6 步、或没有
			// 工具调用都停轮。
			if requestedPropose || step >= maxSteps || len(result.ToolCalls) == 0 {
				break
			}

			next := aiclient.StepRequest{
				System:             system,
				Temperature:        temperature,
				MaxOutputTokens:    maxOutputTokens,
				PreviousResponseID: result.ResponseID,
			}
			for _, call := range result.ToolCalls {
				output, ok := outputs[call.ID]
				if !ok {
					output = "{}"
				}
				next.FunctionOutputs = append(next.FunctionOutputs, aiclient.FunctionOutputItem{
					CallID: call.ID, Name: call.Name, Output: output,
				})
			}
			request = next
		}
		return nil
	}()

	if runErr != nil {
		fail(runErr)
		return
	}

	if err := textWriter.flush(true, nowMillis()); err != nil {
		fail(err)
		return
	}
	if err := reasoningWriter.flush(true, nowMillis()); err != nil {
		fail(err)
		return
	}
	if _, err := e.finishGenerationTurn(storeCtx, turnID, finalStatus, nil); err != nil {
		fail(err)
		return
	}
	_ = send(WireEvent{Type: "finish", Status: &finalStatus})
}

// wireProposal 把刚创建的提案转成 wire 事件负载。
func wireProposal(record *proposalRecord) *WireProposal {
	var summary []string
	_ = json.Unmarshal([]byte(record.Summary), &summary)
	if summary == nil {
		summary = []string{}
	}
	publicSummary := json.RawMessage("null")
	if record.PublicSummary != "" && record.PublicSummary != "null" {
		publicSummary = json.RawMessage(record.PublicSummary)
	}
	return &WireProposal{
		ID:              record.ID,
		Content:         record.Content,
		Summary:         summary,
		Status:          record.Status,
		SourceRevision:  record.SourceRevision,
		CreatedAt:       jsdate.ISOStringFromUnix(record.CreatedAt),
		PublicSummary:   publicSummary,
		BaselineContent: record.BaselineContent,
	}
}
