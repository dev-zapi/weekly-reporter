package engine

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// fakeClock 让 500ms 节流测试无需真的等待。
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(delta time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(delta)
	c.mu.Unlock()
}

type fakeStep struct {
	events []aiclient.Event
	result *aiclient.StepResult
	err    error
	block  bool
}

type fakeProvider struct {
	mu        sync.Mutex
	steps     []fakeStep
	calls     int
	requests  []aiclient.StepRequest
	entered   chan struct{}
	afterEmit func(index int, event aiclient.Event)
}

func (p *fakeProvider) RunStep(ctx context.Context, req aiclient.StepRequest, emit func(aiclient.Event) error) (*aiclient.StepResult, error) {
	p.mu.Lock()
	index := p.calls
	p.calls++
	p.requests = append(p.requests, req)
	p.mu.Unlock()

	step := fakeStep{}
	if len(p.steps) > 0 {
		if index < len(p.steps) {
			step = p.steps[index]
		} else {
			step = p.steps[len(p.steps)-1]
		}
	}
	if p.entered != nil {
		select {
		case p.entered <- struct{}{}:
		default:
		}
	}
	for eventIndex, event := range step.events {
		if err := emit(event); err != nil {
			return nil, err
		}
		if p.afterEmit != nil {
			p.afterEmit(eventIndex, event)
		}
	}
	if step.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if step.err != nil {
		return nil, step.err
	}
	if step.result != nil {
		return step.result, nil
	}
	return &aiclient.StepResult{}, nil
}

type factory struct {
	provider *fakeProvider
	configs  []aiclient.Config
	options  []int
}

func (f *factory) new(cfg aiclient.Config, tools []aiclient.Tool, opts ...aiclient.StepOption) aiclient.StepProvider {
	f.configs = append(f.configs, cfg)
	f.options = append(f.options, len(opts))
	return f.provider
}

type harness struct {
	t         *testing.T
	sqlDB     *sql.DB
	queries   *db.Queries
	engine    *Engine
	clock     *fakeClock
	provider  *fakeProvider
	factory   *factory
	reportID  int64
	sessionID int64
}

func newHarness(t *testing.T, provider *fakeProvider, options ...func(*Options)) *harness {
	t.Helper()
	sqlDB := dbtest.New(t)
	queries := db.New(sqlDB)
	clock := newFakeClock()
	recorder := &factory{provider: provider}

	opts := Options{
		Queries:     queries,
		NewProvider: recorder.new,
		Now:         clock.Now,
	}
	for _, option := range options {
		option(&opts)
	}
	engine := New(opts)

	h := &harness{t: t, sqlDB: sqlDB, queries: queries, engine: engine, clock: clock, provider: provider, factory: recorder}

	res, err := sqlDB.Exec(`INSERT INTO reports (title, content, week_start, week_end, created_at, updated_at)
		VALUES ('周报', 'content', '2026-08-10', '2026-08-16', 1700000000, 1700000000)`)
	if err != nil {
		t.Fatalf("seed report: %v", err)
	}
	h.reportID, _ = res.LastInsertId()

	res, err = sqlDB.Exec(`INSERT INTO report_variants
		(report_id, variant, source_draft, final_status, source_revision, created_at, updated_at)
		VALUES (?, 'personal', '- 事实 A', 'none', 1, 1700000000, 1700000000)`, h.reportID)
	if err != nil {
		t.Fatalf("seed variant: %v", err)
	}
	variantID, _ := res.LastInsertId()

	res, err = sqlDB.Exec(`INSERT INTO generation_sessions (
		report_id, report_variant_id, variant, title, status, source_revision, source_draft_snapshot,
		source_overview, template_id, template_name, template_content, ai_style_key, ai_style_label,
		ai_style_prompt, temperature, system_prompt, tool_rules, created_at, updated_at)
		VALUES (?, ?, 'personal', '会话', 'active', 1, '- 事实 A', '-', 'official-general', '通用',
		'# 模板', 'formal', '正式', '风格提示', '0.3', 'SYSTEM', 'TOOL', 1700000000, 1700000000)`,
		h.reportID, variantID)
	if err != nil {
		t.Fatalf("seed session: %v", err)
	}
	h.sessionID, _ = res.LastInsertId()

	if _, err := sqlDB.Exec(`INSERT INTO ai_config (protocol, api_url, api_key, model, created_at, updated_at)
		VALUES ('openai-compatible', 'http://mock', 'key', 'model', 1700000000, 1700000000)`); err != nil {
		t.Fatalf("seed ai_config: %v", err)
	}
	return h
}

func (h *harness) prepare(message string) *PreparedTurn {
	h.t.Helper()
	prepared, err := h.engine.PrepareTurn(context.Background(), h.reportID, h.sessionID, message)
	if err != nil {
		h.t.Fatalf("prepare turn: %v", err)
	}
	return prepared
}

func (h *harness) stream(prepared *PreparedTurn) *httptest.ResponseRecorder {
	h.t.Helper()
	recorder := httptest.NewRecorder()
	h.engine.StreamTurn(recorder, httptest.NewRequest(http.MethodPost, "/turns", nil), prepared)
	return recorder
}

func parseNDJSON(t *testing.T, recorder *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	events := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("invalid NDJSON line %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

func eventTypes(events []map[string]any) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		text, _ := event["type"].(string)
		types = append(types, text)
	}
	return types
}

func containsType(events []map[string]any, want string) bool {
	for _, event := range events {
		if event["type"] == want {
			return true
		}
	}
	return false
}

func (h *harness) turnStatus(turnID int64) (string, *string) {
	h.t.Helper()
	var status string
	var errorMessage *string
	if err := h.sqlDB.QueryRow(`SELECT status, error FROM generation_turns WHERE id = ?`, turnID).Scan(&status, &errorMessage); err != nil {
		h.t.Fatalf("read turn: %v", err)
	}
	return status, errorMessage
}

func (h *harness) countParts(partType string) int {
	h.t.Helper()
	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_message_parts WHERE session_id = ? AND part_type = ?`,
		h.sessionID, partType).Scan(&count); err != nil {
		h.t.Fatalf("count %s parts: %v", partType, err)
	}
	return count
}

func (h *harness) latestPartContent(partType string) string {
	h.t.Helper()
	var content sql.NullString
	if err := h.sqlDB.QueryRow(`SELECT content FROM generation_message_parts WHERE session_id = ? AND part_type = ? ORDER BY sequence DESC LIMIT 1`,
		h.sessionID, partType).Scan(&content); err != nil {
		h.t.Fatalf("read %s part: %v", partType, err)
	}
	return content.String
}

func (h *harness) statusPartContent() string {
	h.t.Helper()
	var content sql.NullString
	if err := h.sqlDB.QueryRow(`SELECT content FROM generation_message_parts WHERE session_id = ? AND part_type = 'status' ORDER BY sequence DESC LIMIT 1`,
		h.sessionID).Scan(&content); err != nil {
		h.t.Fatalf("read status part: %v", err)
	}
	return content.String
}

func TestHappyTurnEmitsWireEventsAndPersists(t *testing.T) {
	toolCall := aiclient.StepToolCall{ID: "call_1", Name: reportListToolName, Input: `{"limit":1}`}
	provider := &fakeProvider{steps: []fakeStep{
		{
			events: []aiclient.Event{
				{Kind: aiclient.EventReasoningDelta, Text: "思考"},
				{Kind: aiclient.EventToolInputStart, ToolCallID: "call_1", ToolName: reportListToolName},
				{Kind: aiclient.EventToolInputDelta, ToolCallID: "call_1", ToolName: reportListToolName},
				{Kind: aiclient.EventToolCall, ToolCallID: "call_1", ToolName: reportListToolName, Input: `{"limit":1}`},
			},
			result: &aiclient.StepResult{ToolCalls: []aiclient.StepToolCall{toolCall}, ResponseID: "resp-1"},
		},
		{
			events: []aiclient.Event{{Kind: aiclient.EventTextDelta, Text: "答"}},
			result: &aiclient.StepResult{},
		},
	}}
	h := newHarness(t, provider)
	prepared := h.prepare("用户消息")
	recorder := h.stream(prepared)
	events := parseNDJSON(t, recorder)

	for _, want := range []string{"start", "working", "reasoning-delta", "tool-input-delta", "tool-call", "tool-result", "text-delta", "finish"} {
		if !containsType(events, want) {
			t.Fatalf("wire events missing %q: %v", want, eventTypes(events))
		}
	}
	last := events[len(events)-1]
	if last["type"] != "finish" || last["status"] != "completed" {
		t.Fatalf("last event = %v", last)
	}

	status, message := h.turnStatus(prepared.Turn.ID)
	if status != "completed" || message != nil {
		t.Fatalf("turn = %q/%v, want completed/nil", status, message)
	}
	if got := h.statusPartContent(); got != "Completed" {
		t.Fatalf("status part = %q", got)
	}
	if got := h.latestPartContent("reasoning"); got != "思考" {
		t.Fatalf("reasoning part = %q", got)
	}
	if got := h.latestPartContent("text"); got != "答" {
		t.Fatalf("text part = %q", got)
	}
	if got := h.latestPartContent("tool-result"); got != "查询周报列表完成：未找到符合条件的历史周报。历史参考·不可信。" {
		t.Fatalf("tool-result content = %q", got)
	}
	var snapshots int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_query_snapshots WHERE session_id = ?`, h.sessionID).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if snapshots != 1 {
		t.Fatalf("snapshots = %d, want 1", snapshots)
	}

	if len(provider.requests) != 2 {
		t.Fatalf("provider calls = %d, want 2", len(provider.requests))
	}
	second := provider.requests[1]
	if second.PreviousResponseID != "resp-1" {
		t.Fatalf("second PreviousResponseID = %q", second.PreviousResponseID)
	}
	if len(second.FunctionOutputs) != 1 || second.FunctionOutputs[0].CallID != "call_1" {
		t.Fatalf("second FunctionOutputs = %+v", second.FunctionOutputs)
	}
	if len(second.Messages) != 0 {
		t.Fatalf("continuation step must not replay transcript: %+v", second.Messages)
	}

	if len(h.factory.configs) != 1 || h.factory.options[0] != 0 {
		t.Fatalf("provider factory = %+v", h.factory)
	}
}

func TestProposeStopsAfterExecutionAndEmitsProposal(t *testing.T) {
	input := `{"content":"# 终版","summary":["调整"],"publicSummary":{"modelHandling":["仅用原稿"]}}`
	provider := &fakeProvider{steps: []fakeStep{{
		events: []aiclient.Event{
			{Kind: aiclient.EventTextDelta, Text: "说明"},
			{Kind: aiclient.EventToolCall, ToolCallID: "call_p", ToolName: proposeToolName, Input: input},
		},
		result: &aiclient.StepResult{
			ToolCalls:  []aiclient.StepToolCall{{ID: "call_p", Name: proposeToolName, Input: input}},
			ResponseID: "resp-p",
		},
	}}}
	h := newHarness(t, provider)
	prepared := h.prepare("提交终版")
	events := parseNDJSON(t, h.stream(prepared))

	if provider.calls != 1 {
		t.Fatalf("provider calls = %d, want 1 (hasToolCall stops after execution)", provider.calls)
	}
	if !containsType(events, "proposal") {
		t.Fatalf("missing proposal event: %v", eventTypes(events))
	}
	var proposalEvent map[string]any
	for _, event := range events {
		if event["type"] == "proposal" {
			proposalEvent = event
		}
	}
	proposal := proposalEvent["proposal"].(map[string]any)
	if proposal["status"] != "pending" || proposal["content"] != "# 终版" {
		t.Fatalf("proposal payload = %v", proposal)
	}
	createdAt, _ := proposal["createdAt"].(string)
	if len(createdAt) != 24 || !strings.HasSuffix(createdAt, "Z") || createdAt[19] != '.' {
		t.Fatalf("createdAt = %q, want Date.toJSON format", createdAt)
	}
	publicSummary, ok := proposal["publicSummary"].(map[string]any)
	if !ok || publicSummary["version"] != float64(1) {
		t.Fatalf("publicSummary = %v", proposal["publicSummary"])
	}
	if arrays := []string{"modelHandling", "historicalReferences", "failureStates", "truncationStates", "changeSummary"}; len(arrays) > 0 {
		for _, field := range arrays {
			if publicSummary[field] == nil {
				t.Fatalf("publicSummary.%s is null", field)
			}
		}
	}
	if got := h.latestPartContent("tool-result"); got != "候选终版已提交，等待用户确认。" {
		t.Fatalf("tool-result content = %q", got)
	}
	var proposals int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_proposals WHERE session_id = ?`, h.sessionID).Scan(&proposals); err != nil {
		t.Fatal(err)
	}
	if proposals != 1 {
		t.Fatalf("proposals = %d, want 1", proposals)
	}
	if status, _ := h.turnStatus(prepared.Turn.ID); status != "completed" {
		t.Fatalf("turn status = %q, want completed", status)
	}
}

func TestInvalidProposeStillStopsTheLoop(t *testing.T) {
	input := `{}`
	provider := &fakeProvider{steps: []fakeStep{{
		events: []aiclient.Event{{Kind: aiclient.EventToolCall, ToolCallID: "call_p", ToolName: proposeToolName, Input: input}},
		result: &aiclient.StepResult{ToolCalls: []aiclient.StepToolCall{{ID: "call_p", Name: proposeToolName, Input: input}}},
	}}}
	h := newHarness(t, provider)
	prepared := h.prepare("提交")
	events := parseNDJSON(t, h.stream(prepared))

	if provider.calls != 1 {
		t.Fatalf("provider calls = %d, want 1 (invalid propose still satisfies hasToolCall)", provider.calls)
	}
	if containsType(events, "proposal") {
		t.Fatalf("no proposal should be created")
	}
	if !containsType(events, "tool-result") {
		t.Fatalf("missing tool-result for the tool error")
	}
	if status, _ := h.turnStatus(prepared.Turn.ID); status != "completed" {
		t.Fatalf("turn status = %q, want completed", status)
	}
}

func TestStepLimitRunsExactlySixSteps(t *testing.T) {
	call := aiclient.StepToolCall{ID: "call_loop", Name: reportListToolName, Input: `{"limit":1}`}
	provider := &fakeProvider{steps: []fakeStep{{
		events: []aiclient.Event{{Kind: aiclient.EventToolCall, ToolCallID: "call_loop", ToolName: reportListToolName, Input: `{"limit":1}`}},
		result: &aiclient.StepResult{ToolCalls: []aiclient.StepToolCall{call}},
	}}}
	h := newHarness(t, provider)
	prepared := h.prepare("循环")
	h.stream(prepared)

	if provider.calls != 6 {
		t.Fatalf("provider calls = %d, want 6 (isStepCount(6))", provider.calls)
	}
	if got := h.countParts("tool-call"); got != 6 {
		t.Fatalf("tool-call parts = %d, want 6", got)
	}
	if got := h.countParts("tool-result"); got != 6 {
		t.Fatalf("tool-result parts = %d, want 6", got)
	}
	if status, _ := h.turnStatus(prepared.Turn.ID); status != "completed" {
		t.Fatalf("turn status = %q", status)
	}
}

func TestStopPathAbortsAndKeepsFlushedText(t *testing.T) {
	provider := &fakeProvider{
		entered: make(chan struct{}, 1),
		steps: []fakeStep{{
			events: []aiclient.Event{{Kind: aiclient.EventTextDelta, Text: "已有文本"}},
			block:  true,
		}},
	}
	h := newHarness(t, provider)
	prepared := h.prepare("停止")

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- h.stream(prepared) }()
	<-provider.entered

	stopTurn, err := h.engine.StopTurn(context.Background(), prepared.Turn.ID)
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if stopTurn.Status != "aborted" && stopTurn.Status != "working" {
		t.Fatalf("stop returned status %q", stopTurn.Status)
	}
	recorder := <-done
	events := parseNDJSON(t, recorder)
	if !containsType(events, "finish") {
		t.Fatalf("missing finish event: %v", eventTypes(events))
	}
	last := events[len(events)-1]
	if last["type"] != "finish" || last["status"] != "aborted" {
		t.Fatalf("last event = %v", last)
	}
	if status, _ := h.turnStatus(prepared.Turn.ID); status != "aborted" {
		t.Fatalf("turn status = %q, want aborted", status)
	}
	if got := h.statusPartContent(); got != "Stopped" {
		t.Fatalf("status part = %q, want Stopped", got)
	}
	if got := h.latestPartContent("text"); got != "已有文本" {
		t.Fatalf("flushed text = %q, want 已有文本", got)
	}
}

func TestClientDisconnectAbortsWithoutHangingTurn(t *testing.T) {
	provider := &fakeProvider{
		entered: make(chan struct{}, 1),
		steps: []fakeStep{{
			events: []aiclient.Event{{Kind: aiclient.EventTextDelta, Text: "断开前"}},
			block:  true,
		}},
	}
	h := newHarness(t, provider)
	prepared := h.prepare("断开")

	requestContext, cancelRequest := context.WithCancel(context.Background())
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/turns", nil).WithContext(requestContext)
	done := make(chan struct{})
	go func() {
		h.engine.StreamTurn(recorder, request, prepared)
		close(done)
	}()
	<-provider.entered
	cancelRequest()
	<-done

	if status, _ := h.turnStatus(prepared.Turn.ID); status != "aborted" {
		t.Fatalf("turn status = %q, want aborted", status)
	}
	if got := h.statusPartContent(); got != "Stopped" {
		t.Fatalf("status part = %q, want Stopped", got)
	}
	if got := h.latestPartContent("text"); got != "断开前" {
		t.Fatalf("flushed text = %q", got)
	}
}

func TestProviderFailureMarksTurnFailed(t *testing.T) {
	provider := &fakeProvider{steps: []fakeStep{{
		events: []aiclient.Event{{Kind: aiclient.EventTextDelta, Text: "部分"}},
		err:    errTestProvider,
	}}}
	h := newHarness(t, provider)
	prepared := h.prepare("失败")
	events := parseNDJSON(t, h.stream(prepared))

	if !containsType(events, "error") {
		t.Fatalf("missing error event: %v", eventTypes(events))
	}
	status, message := h.turnStatus(prepared.Turn.ID)
	if status != "failed" || message == nil || *message != errTestProvider.Error() {
		t.Fatalf("turn = %q/%v", status, message)
	}
	if got := h.statusPartContent(); got != "Generation failed" {
		t.Fatalf("status part = %q", got)
	}
	var errorParts int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_message_parts WHERE session_id = ? AND part_type = 'error'`, h.sessionID).Scan(&errorParts); err != nil {
		t.Fatal(err)
	}
	if errorParts != 1 {
		t.Fatalf("error parts = %d, want 1", errorParts)
	}
}

func TestThrottledTextWritesCoalesceAt500ms(t *testing.T) {
	provider := &fakeProvider{}
	h := newHarness(t, provider)
	var observed []string
	provider.afterEmit = func(index int, event aiclient.Event) {
		if event.Kind != aiclient.EventTextDelta {
			return
		}
		observed = append(observed, h.latestPartContent("text"))
		if index == 1 {
			h.clock.Advance(600 * time.Millisecond)
		}
	}
	provider.steps = []fakeStep{{
		events: []aiclient.Event{
			{Kind: aiclient.EventTextDelta, Text: "A"},
			{Kind: aiclient.EventTextDelta, Text: "B"},
			{Kind: aiclient.EventTextDelta, Text: "C"},
		},
		result: &aiclient.StepResult{},
	}}
	h.stream(h.prepare("节流"))

	want := []string{"A", "A", "ABC"}
	if len(observed) != len(want) {
		t.Fatalf("observed = %v, want %v", observed, want)
	}
	for index := range want {
		if observed[index] != want[index] {
			t.Fatalf("observed = %v, want %v", observed, want)
		}
	}
}

func TestContextLimitUsesUTF16Units(t *testing.T) {
	provider := &fakeProvider{steps: []fakeStep{{result: &aiclient.StepResult{}}}}

	t.Run("450001 ASCII units rejected", func(t *testing.T) {
		h := newHarness(t, provider)
		if _, err := h.sqlDB.Exec(`UPDATE generation_sessions SET source_draft_snapshot = ? WHERE id = ?`,
			strings.Repeat("a", 450_001), h.sessionID); err != nil {
			t.Fatal(err)
		}
		_, err := h.engine.PrepareTurn(context.Background(), h.reportID, h.sessionID, "消息")
		var serviceError *ServiceError
		if !asServiceError(err, &serviceError) || serviceError.Code != "CONTEXT_LIMIT" {
			t.Fatalf("err = %v, want CONTEXT_LIMIT", err)
		}
	})

	t.Run("exactly 450000 units accepted", func(t *testing.T) {
		h := newHarness(t, provider)
		// 其余上下文（模板/系统提示/风格/工具规则）固定占 18 个 UTF-16 码元；
		// 原稿补到 450,000 整，验证上限是 `> 450_000` 而不是 `>=`。
		if _, err := h.sqlDB.Exec(`UPDATE generation_sessions SET source_draft_snapshot = ? WHERE id = ?`,
			strings.Repeat("a", 450_000-18), h.sessionID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.engine.PrepareTurn(context.Background(), h.reportID, h.sessionID, "消息"); err != nil {
			t.Fatalf("prepare: %v", err)
		}
	})

	t.Run("CJK counts as one unit per character", func(t *testing.T) {
		h := newHarness(t, provider)
		draft := strings.Repeat("一", 150_001) // 450,003 UTF-8 bytes but 150,001 UTF-16 units
		if _, err := h.sqlDB.Exec(`UPDATE generation_sessions SET source_draft_snapshot = ? WHERE id = ?`, draft, h.sessionID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.engine.PrepareTurn(context.Background(), h.reportID, h.sessionID, "消息"); err != nil {
			t.Fatalf("CJK draft must not hit the byte-length trap: %v", err)
		}
	})
}

func TestProposalSizeLimitUsesUTF16Units(t *testing.T) {
	oversized := strings.Repeat("a", 200_001)
	input := `{"content":"` + oversized + `","summary":["s"]}`
	provider := &fakeProvider{steps: []fakeStep{{
		events: []aiclient.Event{{Kind: aiclient.EventToolCall, ToolCallID: "call_p", ToolName: proposeToolName, Input: input}},
		result: &aiclient.StepResult{ToolCalls: []aiclient.StepToolCall{{ID: "call_p", Name: proposeToolName, Input: input}}},
	}}}
	h := newHarness(t, provider)
	prepared := h.prepare("超长")
	events := parseNDJSON(t, h.stream(prepared))

	if containsType(events, "proposal") {
		t.Fatalf("oversized proposal must not be created")
	}
	var proposals int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_proposals WHERE session_id = ?`, h.sessionID).Scan(&proposals); err != nil {
		t.Fatal(err)
	}
	if proposals != 0 {
		t.Fatalf("proposals = %d, want 0", proposals)
	}
	if status, _ := h.turnStatus(prepared.Turn.ID); status != "completed" {
		t.Fatalf("turn status = %q", status)
	}
}

func TestReplayOptionIsWiredThrough(t *testing.T) {
	provider := &fakeProvider{steps: []fakeStep{{result: &aiclient.StepResult{}}}}
	h := newHarness(t, provider, func(opts *Options) { opts.ReplayOutputItems = true })
	h.stream(h.prepare("回放"))
	if len(h.factory.options) != 1 || h.factory.options[0] != 1 {
		t.Fatalf("options = %v, want one replay StepOption", h.factory.options)
	}

	providerDefault := &fakeProvider{steps: []fakeStep{{result: &aiclient.StepResult{}}}}
	h2 := newHarness(t, providerDefault)
	h2.stream(h2.prepare("默认"))
	if len(h2.factory.options) != 1 || h2.factory.options[0] != 0 {
		t.Fatalf("options = %v, want none by default", h2.factory.options)
	}
}

func asServiceError(err error, target **ServiceError) bool {
	serviceError, ok := err.(*ServiceError)
	if ok {
		*target = serviceError
	}
	return ok
}

var errTestProvider = &testProviderError{}

type testProviderError struct{}

func (*testProviderError) Error() string { return "provider boom" }
