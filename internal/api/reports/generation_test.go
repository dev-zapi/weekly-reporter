package reports_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/engine"
)

// 本文件是 src/app/api/reports/[id]/generate/route.test.ts 的 Go 同用例集
// （ADR-0029），外加 5 条生成引擎路由的 httptest 行为面。引擎循环语义本身由
// internal/engine 的单测覆盖；这里断言 HTTP 契约（状态码、错误形状、NDJSON 头、
// 事件行与落库副作用）。

// ---- 一次性 Responses mock（generate 路由）----

type responsesMock struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	requests []map[string]any
	text     string
	status   int
}

func newResponsesMock(t *testing.T, text string) *responsesMock {
	t.Helper()
	m := &responsesMock{t: t, text: text, status: http.StatusOK}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		var body map[string]any
		_ = json.Unmarshal(raw, &body)

		m.mu.Lock()
		m.requests = append(m.requests, body)
		status, text := m.status, m.text
		m.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if status < 200 || status > 299 {
			// 让 aiclient 的重试立即发生（不发指数退避等待）。
			w.Header().Set("Retry-After-Ms", "0")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"provider down"}}`))
			return
		}
		payload, _ := json.Marshal(map[string]any{
			"id": "resp_mock",
			"output": []any{map[string]any{
				"type": "message",
				"role": "assistant",
				"content": []any{map[string]any{
					"type": "output_text",
					"text": text,
				}},
			}},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(m.server.Close)
	return m
}

func (m *responsesMock) url() string { return m.server.URL }

func (m *responsesMock) lastRequest() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.requests) == 0 {
		m.t.Fatal("responses mock received no request")
	}
	return m.requests[len(m.requests)-1]
}

// ---- 流式 fake provider（turns 路由）----

type routeFakeStep struct {
	events []aiclient.Event
	result *aiclient.StepResult
	err    error
	block  bool
}

type routeFakeProvider struct {
	mu    sync.Mutex
	steps []routeFakeStep
	calls int
	ready chan struct{}
}

func (p *routeFakeProvider) RunStep(ctx context.Context, req aiclient.StepRequest, emit func(aiclient.Event) error) (*aiclient.StepResult, error) {
	p.mu.Lock()
	index := p.calls
	p.calls++
	p.mu.Unlock()

	step := routeFakeStep{}
	if len(p.steps) > 0 {
		if index < len(p.steps) {
			step = p.steps[index]
		} else {
			step = p.steps[len(p.steps)-1]
		}
	}
	for _, event := range step.events {
		if err := emit(event); err != nil {
			return nil, err
		}
	}
	if p.ready != nil {
		select {
		case p.ready <- struct{}{}:
		default:
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

func factoryFor(provider aiclient.StepProvider) engine.ProviderFactory {
	return func(cfg aiclient.Config, tools []aiclient.Tool, opts ...aiclient.StepOption) aiclient.StepProvider {
		return provider
	}
}

// ---- generate route（vitest 用例转换）----

func TestGenerateReportSendsOnlyTheSelectedLeadershipDraft(t *testing.T) {
	mock := newResponsesMock(t, `{"summary":["采用本周工作章节","保留领导可见事项"],"content":"# 终版"}`)
	h := newHarness(t)
	reportID := h.seedReport("周报", "content", "2026-08-10", "2026-08-16", 1700000000)
	h.seedVariant(reportID, "leadership", "- 领导可见事项", nil, 4, nil)
	h.seedVariant(reportID, "personal", "- 私人项目事项", nil, 4, nil)
	h.seedTemplate(1, "通用模板", "# 本周工作", "formal")
	h.seedAIConfig("openai", mock.url(), "mock-model")

	rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generate",
		`{"variant":"leadership","templateId":"user-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Content        string   `json:"content"`
		Summary        []string `json:"summary"`
		Variant        string   `json:"variant"`
		AiStyle        string   `json:"aiStyle"`
		SourceRevision int64    `json:"sourceRevision"`
		Template       struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Content string `json:"content"`
			AiStyle string `json:"aiStyle"`
		} `json:"template"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.Content != "# 终版" || len(body.Summary) != 2 || body.Summary[0] != "采用本周工作章节" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if body.Variant != "leadership" || body.SourceRevision != 4 || body.AiStyle != "formal" {
		t.Fatalf("variant/aiStyle/revision = %q/%q/%d", body.Variant, body.AiStyle, body.SourceRevision)
	}
	if body.Template.ID != "user-1" || body.Template.Name != "通用模板" || body.Template.Content != "# 本周工作" || body.Template.AiStyle != "formal" {
		t.Fatalf("template = %+v", body.Template)
	}
	if strings.Contains(rec.Body.String(), "私人项目事项") {
		t.Fatalf("response leaked the other audience's draft")
	}

	request := mock.lastRequest()
	if request["model"] != "mock-model" {
		t.Fatalf("model = %v", request["model"])
	}
	if temperature, ok := request["temperature"].(float64); !ok || temperature != 0.3 {
		t.Fatalf("temperature = %v, want 0.3 (formal style)", request["temperature"])
	}
	prompt := promptText(t, request)
	for _, want := range []string{"- 领导可见事项", "# 本周工作", "受众版本：领导版"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "私人项目事项") {
		t.Fatalf("prompt leaked the personal draft")
	}
}

func promptText(t *testing.T, request map[string]any) string {
	t.Helper()
	input, _ := request["input"].([]any)
	if len(input) == 0 {
		t.Fatalf("request input missing: %v", request)
	}
	message, _ := input[0].(map[string]any)
	content, _ := message["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("request content missing: %v", message)
	}
	part, _ := content[0].(map[string]any)
	text, _ := part["text"].(string)
	return text
}

func TestGenerateReportValidationAndErrorBranches(t *testing.T) {
	t.Run("invalid report id", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPost, "/api/reports/abc/generate", `{}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"INVALID_ID"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("invalid input", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPost, "/api/reports/1/generate", `{"variant":"leadership"}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"INVALID_INPUT"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPost, "/api/reports/1/generate", `{"variant":`)
		if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"GENERATION_ERROR"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("report not found", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPost, "/api/reports/999/generate", `{"variant":"personal","templateId":"user-1"}`)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"NOT_FOUND"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("variant not found", func(t *testing.T) {
		h := newHarness(t)
		reportID := h.seedReport("周报", "", "2026-08-10", "2026-08-16", 1700000000)
		h.seedVariant(reportID, "leadership", "- 事实", nil, 1, nil)
		rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generate", `{"variant":"personal","templateId":"user-1"}`)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"VARIANT_NOT_FOUND"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("empty source draft", func(t *testing.T) {
		h := newHarness(t)
		reportID := h.seedReport("周报", "", "2026-08-10", "2026-08-16", 1700000000)
		h.seedVariant(reportID, "personal", "", nil, 0, nil)
		rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generate", `{"variant":"personal","templateId":"user-1"}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"EMPTY_SOURCE_DRAFT"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("template not found", func(t *testing.T) {
		h := newHarness(t)
		reportID := h.seedReport("周报", "", "2026-08-10", "2026-08-16", 1700000000)
		h.seedVariant(reportID, "personal", "- 事实", nil, 1, nil)
		rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generate", `{"variant":"personal","templateId":"user-99"}`)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"TEMPLATE_NOT_FOUND"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("ai not configured", func(t *testing.T) {
		h := newHarness(t)
		reportID := h.seedReport("周报", "", "2026-08-10", "2026-08-16", 1700000000)
		h.seedVariant(reportID, "personal", "- 事实", nil, 1, nil)
		h.seedTemplate(1, "通用模板", "# 模板", "formal")
		rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generate", `{"variant":"personal","templateId":"user-1"}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"AI_NOT_CONFIGURED"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("provider failure", func(t *testing.T) {
		mock := newResponsesMock(t, "")
		mock.status = http.StatusBadGateway
		h := newHarness(t)
		reportID := h.seedReport("周报", "", "2026-08-10", "2026-08-16", 1700000000)
		h.seedVariant(reportID, "personal", "- 事实", nil, 1, nil)
		h.seedTemplate(1, "通用模板", "# 模板", "formal")
		h.seedAIConfig("openai", mock.url(), "mock-model")
		rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generate", `{"variant":"personal","templateId":"user-1"}`)
		if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"GENERATION_ERROR"`) {
			t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
		}
		var body struct {
			Details string `json:"details"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body.Details == "" {
			t.Fatalf("details missing: %s", rec.Body.String())
		}
	})
}

// ---- turns route ----

func newStreamHarness(t *testing.T, provider aiclient.StepProvider) (*harness, int64, int64) {
	t.Helper()
	h := newHarnessWithOptions(t, api.Options{EngineProvider: factoryFor(provider)})
	reportID := h.seedReport("周报", "content", "2026-08-10", "2026-08-16", 1700000000)
	variantID := h.seedVariant(reportID, "personal", "- 事实 A", nil, 1, nil)
	sessionID := h.seedSession(reportID, variantID, "personal", "会话", 1, 1700000100)
	h.seedAIConfig("openai-compatible", "http://mock", "model")
	return h, reportID, sessionID
}

func turnPath(reportID, sessionID int64) string {
	return "/api/reports/" + itoa(reportID) + "/generation-sessions/" + itoa(sessionID)
}

func TestTurnsRouteValidation(t *testing.T) {
	h, reportID, sessionID := newStreamHarness(t, &routeFakeProvider{})

	rec := h.do(http.MethodPost, "/api/reports/x/generation-sessions/1/turns", `{"message":"hi"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("invalid id: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns", `{}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"EMPTY_MESSAGE"`) {
		t.Fatalf("empty message: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns", `{"message":"  "}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"EMPTY_MESSAGE"`) {
		t.Fatalf("blank message: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns", `null`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"GENERATION_START_ERROR"`) {
		t.Fatalf("null body: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, turnPath(reportID, 999)+"/turns", `{"message":"hi"}`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"SESSION_NOT_FOUND"`) {
		t.Fatalf("missing session: %d %s", rec.Code, rec.Body.String())
	}
}

func TestTurnsRouteStreamsNDJSONAndFinishesTurn(t *testing.T) {
	provider := &routeFakeProvider{steps: []routeFakeStep{{
		events: []aiclient.Event{{Kind: aiclient.EventTextDelta, Text: "回答"}},
		result: &aiclient.StepResult{},
	}}}
	h, reportID, sessionID := newStreamHarness(t, provider)

	rec := h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns", `{"message":"你好"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if contentType := rec.Header().Get("Content-Type"); contentType != "application/x-ndjson; charset=utf-8" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if rec.Header().Get("X-Accel-Buffering") != "no" || rec.Header().Get("Cache-Control") != "no-cache, no-transform" {
		t.Fatalf("stream headers missing: %v", rec.Header())
	}
	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	types := make([]string, 0, len(lines))
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("invalid NDJSON line %q: %v", line, err)
		}
		types = append(types, event["type"].(string))
	}
	for _, want := range []string{"start", "working", "text-delta", "finish"} {
		found := false
		for _, got := range types {
			if got == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q in %v", want, types)
		}
	}

	var status string
	if err := h.sqlDB.QueryRow(`SELECT status FROM generation_turns WHERE session_id = ?`, sessionID).Scan(&status); err != nil {
		t.Fatalf("read turn: %v", err)
	}
	if status != "completed" {
		t.Fatalf("turn status = %q", status)
	}
}

func TestTurnsRouteArchivedAndStaleSessions(t *testing.T) {
	h, reportID, sessionID := newStreamHarness(t, &routeFakeProvider{})

	if _, err := h.sqlDB.Exec(`UPDATE generation_sessions SET status = 'archived' WHERE id = ?`, sessionID); err != nil {
		t.Fatal(err)
	}
	rec := h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns", `{"message":"hi"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"SESSION_ARCHIVED"`) {
		t.Fatalf("archived: %d %s", rec.Code, rec.Body.String())
	}

	// 原稿版本推进 → 会话快照过期。
	if _, err := h.sqlDB.Exec(`UPDATE report_variants SET source_revision = 2 WHERE report_id = ? AND variant = 'personal'`, reportID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.sqlDB.Exec(`UPDATE generation_sessions SET status = 'active' WHERE id = ?`, sessionID); err != nil {
		t.Fatal(err)
	}
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns", `{"message":"hi"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"SOURCE_REVISION_CONFLICT"`) {
		t.Fatalf("stale: %d %s", rec.Code, rec.Body.String())
	}
}

// ---- stop route ----

func TestStopRoute(t *testing.T) {
	h, reportID, sessionID := newStreamHarness(t, &routeFakeProvider{})

	rec := h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns/x/stop", "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("invalid id: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns/999/stop", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"TURN_NOT_FOUND"`) {
		t.Fatalf("missing turn: %d %s", rec.Code, rec.Body.String())
	}

	// 已完成轮次：原样返回 completed。
	res, err := h.sqlDB.Exec(`INSERT INTO generation_turns (session_id, status, protocol, model, created_at)
		VALUES (?, 'completed', 'openai-compatible', 'model', 1700000000)`, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	turnID, _ := res.LastInsertId()
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/turns/"+itoa(turnID)+"/stop", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ID != turnID || body.Status != "completed" {
		t.Fatalf("body = %+v", body)
	}
}

// ---- accept route ----

func seedProposal(t *testing.T, h *harness, reportID, sessionID int64, status string, sourceRevision int64) int64 {
	t.Helper()
	res, err := h.sqlDB.Exec(`INSERT INTO generation_turns (session_id, status, protocol, model, created_at)
		VALUES (?, 'completed', 'openai-compatible', 'model', 1700000000)`, sessionID)
	if err != nil {
		t.Fatalf("seed turn: %v", err)
	}
	turnID, _ := res.LastInsertId()
	res, err = h.sqlDB.Exec(`INSERT INTO generation_proposals
		(session_id, turn_id, content, summary, source_revision, status, public_summary, baseline_content, created_at)
		VALUES (?, ?, '# 提案正文', '["摘要"]', ?, ?, NULL, '', 1700000100)`,
		sessionID, turnID, sourceRevision, status)
	if err != nil {
		t.Fatalf("seed proposal: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestAcceptProposalRoute(t *testing.T) {
	h, reportID, sessionID := newStreamHarness(t, &routeFakeProvider{})
	proposalID := seedProposal(t, h, reportID, sessionID, "pending", 1)

	rec := h.do(http.MethodPost, turnPath(reportID, sessionID)+"/proposals/"+itoa(proposalID)+"/accept", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Session struct {
			ID int64 `json:"id"`
		} `json:"session"`
		Proposal struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		} `json:"proposal"`
		Variant struct {
			FinalContent       *string `json:"finalContent"`
			FinalStatus        string  `json:"finalStatus"`
			AcceptedProposalID *int64  `json:"acceptedProposalId"`
		} `json:"variant"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if body.Session.ID != sessionID || body.Proposal.ID != proposalID || body.Proposal.Status != "accepted" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if body.Variant.FinalContent == nil || *body.Variant.FinalContent != "# 提案正文" ||
		body.Variant.FinalStatus != "current" ||
		body.Variant.AcceptedProposalID == nil || *body.Variant.AcceptedProposalID != proposalID {
		t.Fatalf("variant = %+v", body.Variant)
	}

	var reportContent string
	if err := h.sqlDB.QueryRow(`SELECT content FROM reports WHERE id = ?`, reportID).Scan(&reportContent); err != nil {
		t.Fatal(err)
	}
	if reportContent != "# 提案正文" {
		t.Fatalf("report content = %q", reportContent)
	}
	var baseline *string
	if err := h.sqlDB.QueryRow(`SELECT baseline_final_content FROM generation_sessions WHERE id = ?`, sessionID).Scan(&baseline); err != nil {
		t.Fatal(err)
	}
	if baseline == nil || *baseline != "# 提案正文" {
		t.Fatalf("session baseline = %v", baseline)
	}
	var parts int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_message_parts WHERE session_id = ? AND part_type = 'proposal-accepted'`, sessionID).Scan(&parts); err != nil {
		t.Fatal(err)
	}
	if parts != 1 {
		t.Fatalf("proposal-accepted parts = %d", parts)
	}
}

func TestAcceptProposalErrors(t *testing.T) {
	h, reportID, sessionID := newStreamHarness(t, &routeFakeProvider{})

	rec := h.do(http.MethodPost, turnPath(reportID, sessionID)+"/proposals/999/accept", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"PROPOSAL_NOT_FOUND"`) {
		t.Fatalf("missing proposal: %d %s", rec.Code, rec.Body.String())
	}

	superseded := seedProposal(t, h, reportID, sessionID, "superseded", 1)
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/proposals/"+itoa(superseded)+"/accept", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"PROPOSAL_SUPERSEDED"`) {
		t.Fatalf("superseded: %d %s", rec.Code, rec.Body.String())
	}

	if _, err := h.sqlDB.Exec(`UPDATE report_variants SET source_revision = 2 WHERE report_id = ? AND variant = 'personal'`, reportID); err != nil {
		t.Fatal(err)
	}
	conflicted := seedProposal(t, h, reportID, sessionID, "pending", 1)
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/proposals/"+itoa(conflicted)+"/accept", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"SOURCE_REVISION_CONFLICT"`) {
		t.Fatalf("revision conflict: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generation-sessions/999/proposals/1/accept", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"SESSION_NOT_FOUND"`) {
		t.Fatalf("missing session: %d %s", rec.Code, rec.Body.String())
	}
}

// ---- refresh route ----

func seedSnapshot(t *testing.T, h *harness, reportID, sessionID int64, toolName string) int64 {
	t.Helper()
	res, err := h.sqlDB.Exec(`INSERT INTO generation_query_snapshots
		(session_id, tool_name, parameters, called_at, source_report_id, source_audience,
		 result, result_count, truncated, duration_ms, trigger, created_at)
		VALUES (?, ?, '{"limit":1}', 1700000000, ?, 'personal',
		'{"ok":true,"items":[],"hasMore":false,"appliedFilters":{"query":null,"title":null,"startDate":null,"endDate":null,"statuses":["current"],"includeLegacy":false,"relation":"overlap","relativeToReportId":null,"cursor":null,"limit":1},"referenceBoundary":{"label":"历史参考·不可信","statement":"x"}}',
		0, 0, 0, 'automatic', 1700000000)`,
		sessionID, toolName, reportID)
	if err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestRefreshQuerySnapshotRoute(t *testing.T) {
	h, reportID, sessionID := newStreamHarness(t, &routeFakeProvider{})
	snapshotID := seedSnapshot(t, h, reportID, sessionID, "query_report_list")

	rec := h.do(http.MethodPost, turnPath(reportID, sessionID)+"/query-snapshots/refresh", `{"snapshotId":`+itoa(snapshotID)+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		ID                 int64  `json:"id"`
		ToolName           string `json:"toolName"`
		Trigger            string `json:"trigger"`
		PreviousSnapshotID *int64 `json:"previousSnapshotId"`
		CreatedAt          string `json:"createdAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if body.ID == snapshotID || body.ToolName != "query_report_list" || body.Trigger != "user" ||
		body.PreviousSnapshotID == nil || *body.PreviousSnapshotID != snapshotID {
		t.Fatalf("body = %s", rec.Body.String())
	}
	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_query_snapshots WHERE session_id = ?`, sessionID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("snapshots = %d, want 2", count)
	}
	var partData string
	if err := h.sqlDB.QueryRow(`SELECT data FROM generation_message_parts WHERE session_id = ? AND part_type = 'tool-result' ORDER BY sequence DESC LIMIT 1`, sessionID).Scan(&partData); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(partData, `"refreshed":true`) || !strings.Contains(partData, `"snapshotId":`) {
		t.Fatalf("refreshed part data = %s", partData)
	}

	// 不支持的 tool → 400。
	unsupported := seedSnapshot(t, h, reportID, sessionID, "query_other")
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/query-snapshots/refresh", `{"snapshotId":`+itoa(unsupported)+`}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"SNAPSHOT_INVALID"`) {
		t.Fatalf("unsupported: %d %s", rec.Code, rec.Body.String())
	}

	// 快照不存在 → 404。
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/query-snapshots/refresh", `{"snapshotId":999}`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"SNAPSHOT_NOT_FOUND"`) {
		t.Fatalf("missing snapshot: %d %s", rec.Code, rec.Body.String())
	}

	// body 解析失败 → 按 {} 处理 → snapshotId 0 → 404（route.ts 的 .catch(() => ({}))）。
	rec = h.do(http.MethodPost, turnPath(reportID, sessionID)+"/query-snapshots/refresh", `{`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"SNAPSHOT_NOT_FOUND"`) {
		t.Fatalf("bad body: %d %s", rec.Code, rec.Body.String())
	}

	// 会话不存在 → 404。
	rec = h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generation-sessions/999/query-snapshots/refresh", `{}`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"SESSION_NOT_FOUND"`) {
		t.Fatalf("missing session: %d %s", rec.Code, rec.Body.String())
	}
}
