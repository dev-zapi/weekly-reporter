package reports_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// generation-sessions 路由无现存 route.test；httptest 补 happy path + {error, code}
// 形状。行为对照 src/app/api/reports/[id]/generation-sessions/**/route.ts。

// seedSessionFixture 准备一个可创建会话的报告：两个变体 + 事件原稿。
func seedSessionFixture(t *testing.T, h *harness) (reportID int64, variantID int64) {
	t.Helper()
	reportID = h.seedReport("报告", "- 工作事项", "2024-01-08", "2024-01-14", 1705310800)
	variantID = h.seedVariant(reportID, "personal", "- **repo**\n  - 完成工作", nil, 3, nil)
	h.seedVariant(reportID, "leadership", "- 完成工作", nil, 3, nil)
	h.seedStyle("formal", "正式汇报", "正式提示词", "0.3", true)
	h.seedSystemPrompt("generate", "终版生成", "生成规则正文。")
	return reportID, variantID
}

func TestListGenerationSessions(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "- 原稿", "2024-01-08", "2024-01-14", 1705310800)
	h.seedSession(reportID, 0, "personal", "较早会话", 1, 1700000100)
	newer := h.seedSession(reportID, 0, "leadership", "较新会话", 1, 1700000900)

	rec := h.do(http.MethodGet, "/api/reports/"+itoa(reportID)+"/generation-sessions", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Sessions []struct {
			ID             int64  `json:"id"`
			Title          string `json:"title"`
			LatestTurn     *any   `json:"latestTurn"`
			LatestProposal *struct {
				PublicSummary *json.RawMessage `json:"publicSummary"`
			} `json:"latestProposal"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if len(body.Sessions) != 2 {
		t.Fatalf("sessions = %d, want 2", len(body.Sessions))
	}
	// updated_at DESC：较新会话在前。
	if body.Sessions[0].ID != newer || body.Sessions[0].Title != "较新会话" {
		t.Fatalf("first session = %+v", body.Sessions[0])
	}
	if body.Sessions[0].LatestTurn != nil || body.Sessions[0].LatestProposal != nil {
		t.Fatalf("new session should have no latest turn/proposal")
	}

	// variant 过滤只接受 leadership/personal。
	rec = h.do(http.MethodGet, "/api/reports/"+itoa(reportID)+"/generation-sessions?variant=leadership", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Sessions) != 1 || body.Sessions[0].ID != newer {
		t.Fatalf("sessions = %+v, want only leadership", body.Sessions)
	}
	rec = h.do(http.MethodGet, "/api/reports/"+itoa(reportID)+"/generation-sessions?variant=bogus", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Sessions) != 2 {
		t.Fatalf("bogus variant should not filter, got %d", len(body.Sessions))
	}
}

func TestListGenerationSessionsInvalidReportID(t *testing.T) {
	h := newHarness(t)
	rec := h.do(http.MethodGet, "/api/reports/abc/generation-sessions", "")
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateGenerationSessionSnapshotsContext(t *testing.T) {
	h := newHarness(t)
	reportID, variantID := seedSessionFixture(t, h)

	rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generation-sessions",
		`{"variant":"personal","templateId":"official-general"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		ID                   int64   `json:"id"`
		ReportID             int64   `json:"reportId"`
		ReportVariantID      int64   `json:"reportVariantId"`
		Variant              string  `json:"variant"`
		Title                string  `json:"title"`
		Status               string  `json:"status"`
		SourceRevision       int64   `json:"sourceRevision"`
		SourceDraftSnapshot  string  `json:"sourceDraftSnapshot"`
		SourceOverview       string  `json:"sourceOverview"`
		TemplateID           string  `json:"templateId"`
		TemplateName         string  `json:"templateName"`
		TemplateContent      string  `json:"templateContent"`
		AiStyleKey           string  `json:"aiStyleKey"`
		AiStyleLabel         string  `json:"aiStyleLabel"`
		AiStylePrompt        string  `json:"aiStylePrompt"`
		Temperature          string  `json:"temperature"`
		SystemPrompt         string  `json:"systemPrompt"`
		ToolRules            string  `json:"toolRules"`
		BaselineFinalContent *string `json:"baselineFinalContent"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.ReportID != reportID || body.ReportVariantID != variantID || body.Variant != "personal" {
		t.Fatalf("session = %+v", body)
	}
	if body.Status != "active" || body.SourceRevision != 3 {
		t.Fatalf("status/revision = %q/%d", body.Status, body.SourceRevision)
	}
	if body.TemplateID != "official-general" || body.TemplateName != "通用正式周报模板" {
		t.Fatalf("template = %q/%q", body.TemplateID, body.TemplateName)
	}
	if !contains(body.TemplateContent, "## 本周完成") {
		t.Fatalf("templateContent = %q", body.TemplateContent)
	}
	// 官方模板的 aiStyle 是 formal；风格查库拿到 seed 的行。
	if body.AiStyleKey != "formal" || body.AiStyleLabel != "正式汇报" || body.AiStylePrompt != "正式提示词" || body.Temperature != "0.3" {
		t.Fatalf("style = %+v", body)
	}
	if !contains(body.SystemPrompt, "生成规则正文。") {
		t.Fatalf("systemPrompt = %q", body.SystemPrompt)
	}
	if !contains(body.ToolRules, "query_report_list") {
		t.Fatalf("toolRules = %q", body.ToolRules)
	}
	if !contains(body.Title, "通用正式周报模板 · ") {
		t.Fatalf("title = %q", body.Title)
	}
	if !contains(body.SourceOverview, "个人版 source draft: 1 events.") {
		t.Fatalf("sourceOverview = %q", body.SourceOverview)
	}

	// 会话同时写入 4 条 system message parts（顺序 1..4）。
	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_message_parts WHERE session_id = ?`, body.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("message parts = %d, want 4", count)
	}
	var partType string
	if err := h.sqlDB.QueryRow(
		`SELECT part_type FROM generation_message_parts WHERE session_id = ? AND sequence = 2`, body.ID,
	).Scan(&partType); err != nil {
		t.Fatal(err)
	}
	if partType != "style-prompt" {
		t.Fatalf("sequence 2 partType = %q, want style-prompt", partType)
	}
}

func TestCreateGenerationSessionErrorShapes(t *testing.T) {
	h := newHarness(t)

	// 非法 id。
	rec := h.do(http.MethodPost, "/api/reports/abc/generation-sessions", `{"variant":"personal","templateId":"official-general"}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("invalid id: %d %s", rec.Code, rec.Body.String())
	}

	// 缺 variant / templateId。
	reportID, _ := seedSessionFixture(t, h)
	rec = h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generation-sessions", `{"variant":"personal"}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_INPUT"`) {
		t.Fatalf("missing template: %d %s", rec.Code, rec.Body.String())
	}

	// 报告不存在。
	rec = h.do(http.MethodPost, "/api/reports/999/generation-sessions", `{"variant":"personal","templateId":"official-general"}`)
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"REPORT_NOT_FOUND"`) {
		t.Fatalf("missing report: %d %s", rec.Code, rec.Body.String())
	}

	// 模板不存在。
	rec = h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/generation-sessions", `{"variant":"personal","templateId":"official-nope"}`)
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"TEMPLATE_NOT_FOUND"`) {
		t.Fatalf("missing template: %d %s", rec.Code, rec.Body.String())
	}

	// 变体不存在（报告只有 personal/leadership，这里查一个不存在的 variant 走
	// INVALID_INPUT —— 变体缺失只对合法 variant 值可达，用已删变体的报告覆盖）。
	emptyReport := h.seedReport("空报告", "x", "2024-01-08", "2024-01-14", 1705310800)
	rec = h.do(http.MethodPost, "/api/reports/"+itoa(emptyReport)+"/generation-sessions", `{"variant":"leadership","templateId":"official-general"}`)
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"VARIANT_NOT_FOUND"`) {
		t.Fatalf("missing variant: %d %s", rec.Code, rec.Body.String())
	}

	// 空原稿 → EMPTY_SOURCE_DRAFT。
	h.seedVariant(emptyReport, "leadership", "- No events this week", nil, 1, nil)
	rec = h.do(http.MethodPost, "/api/reports/"+itoa(emptyReport)+"/generation-sessions", `{"variant":"leadership","templateId":"official-general"}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"EMPTY_SOURCE_DRAFT"`) {
		t.Fatalf("empty draft: %d %s", rec.Code, rec.Body.String())
	}
}

func TestGetGenerationSessionDetail(t *testing.T) {
	h := newHarness(t)
	reportID, variantID := seedSessionFixture(t, h)
	sessionID := h.seedSession(reportID, variantID, "personal", "会话", 3, 1700000500)
	proposalID := h.seedProposal(sessionID, "pending", 3, 1700000400)
	// 用户触发过的历史查询快照（比提案新）→ referenceChanged = true。
	if _, err := h.sqlDB.Exec(
		`INSERT INTO generation_query_snapshots (session_id, tool_name, parameters, called_at, source_report_id, source_audience,
			result, result_count, truncated, duration_ms, trigger, created_at)
		 VALUES (?, 'query_report_list', '{}', 1700000450, ?, 'personal', '{}', 0, 0, 12, 'user', 1700000450)`,
		sessionID, reportID,
	); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, data, created_at)
		 VALUES (?, NULL, 1, 'tool', 'tool-result', 'x', '{"toolName":"query_report_list"}', 1700000300)`, sessionID,
	); err != nil {
		t.Fatalf("seed part: %v", err)
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO generation_turns (session_id, status, protocol, model, created_at)
		 VALUES (?, 'working', 'openai-compatible', 'm', 1700000200)`, sessionID,
	); err != nil {
		t.Fatalf("seed turn: %v", err)
	}

	rec := h.do(http.MethodGet, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		ID                          int64  `json:"id"`
		Title                       string `json:"title"`
		SourceIsCurrent             bool   `json:"sourceIsCurrent"`
		HistoricalReferencesChanged bool   `json:"historicalReferencesChanged"`
		ActiveTurn                  *struct {
			ID int64 `json:"id"`
		} `json:"activeTurn"`
		Messages []struct {
			Sequence int64  `json:"sequence"`
			PartType string `json:"partType"`
		} `json:"messages"`
		Proposals []struct {
			ID               int64            `json:"id"`
			ReferenceChanged bool             `json:"referenceChanged"`
			PublicSummary    *json.RawMessage `json:"publicSummary"`
		} `json:"proposals"`
		QuerySnapshots []struct {
			ID      int64  `json:"id"`
			Trigger string `json:"trigger"`
		} `json:"querySnapshots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.ID != sessionID || body.Title != "会话" {
		t.Fatalf("session = %+v", body)
	}
	if !body.SourceIsCurrent {
		t.Fatalf("sourceIsCurrent = false, want true (variant revision 3)")
	}
	if len(body.Messages) != 1 || body.Messages[0].PartType != "tool-result" {
		t.Fatalf("messages = %+v", body.Messages)
	}
	if len(body.Proposals) != 1 || body.Proposals[0].ID != proposalID {
		t.Fatalf("proposals = %+v", body.Proposals)
	}
	if !body.Proposals[0].ReferenceChanged {
		t.Fatalf("referenceChanged = false, want true")
	}
	if !body.HistoricalReferencesChanged {
		t.Fatalf("historicalReferencesChanged = false, want true")
	}
	if len(body.QuerySnapshots) != 1 || body.QuerySnapshots[0].Trigger != "user" {
		t.Fatalf("querySnapshots = %+v", body.QuerySnapshots)
	}
	if body.ActiveTurn == nil {
		t.Fatalf("activeTurn = nil, want working turn")
	}
}

func TestGetGenerationSessionDetailNotFound(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "x", "2024-01-08", "2024-01-14", 1705310800)
	rec := h.do(http.MethodGet, "/api/reports/"+itoa(reportID)+"/generation-sessions/999", "")
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"SESSION_NOT_FOUND"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodGet, "/api/reports/abc/generation-sessions/1", "")
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	// 注：route.ts 的 GET 分支在 reportId 合法、sessionId 非法时也回 INVALID_ID。
	rec = h.do(http.MethodGet, "/api/reports/"+itoa(reportID)+"/generation-sessions/xyz", "")
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRenameGenerationSession(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "x", "2024-01-08", "2024-01-14", 1705310800)
	sessionID := h.seedSession(reportID, 0, "personal", "旧标题", 1, 1700000100)

	rec := h.do(http.MethodPatch, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), `{"title":"  新标题  "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		ID    int64  `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Title != "新标题" {
		t.Fatalf("title = %q, want trimmed 新标题", body.Title)
	}

	// 非字符串标题 → INVALID_TITLE。
	rec = h.do(http.MethodPatch, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), `{"title":1}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_TITLE"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	// 空白标题 → INVALID_TITLE。
	rec = h.do(http.MethodPatch, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), `{"title":"   "}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_TITLE"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	// 不存在 → SESSION_NOT_FOUND。
	rec = h.do(http.MethodPatch, "/api/reports/"+itoa(reportID)+"/generation-sessions/999", `{"title":"x"}`)
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"SESSION_NOT_FOUND"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// 标题截断到 120 个 UTF-16 码元（slice 语义）。
func TestRenameGenerationSessionTruncatesTo120(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "x", "2024-01-08", "2024-01-14", 1705310800)
	sessionID := h.seedSession(reportID, 0, "personal", "旧标题", 1, 1700000100)

	long := repeat("标", 130)
	rec := h.do(http.MethodPatch, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), `{"title":"`+long+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len([]rune(body.Title)) != 120 {
		t.Fatalf("title length = %d runes, want 120", len([]rune(body.Title)))
	}
}

func TestArchiveGenerationSession(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "x", "2024-01-08", "2024-01-14", 1705310800)
	sessionID := h.seedSession(reportID, 0, "personal", "会话", 1, 1700000100)

	rec := h.do(http.MethodDelete, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Status     string  `json:"status"`
		ArchivedAt *string `json:"archivedAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != "archived" || body.ArchivedAt == nil {
		t.Fatalf("body = %+v, want archived with archivedAt", body)
	}
}

// 有 working 轮次时归档被拒（409 TURN_IN_PROGRESS）。
func TestArchiveGenerationSessionRejectsWorkingTurn(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "x", "2024-01-08", "2024-01-14", 1705310800)
	sessionID := h.seedSession(reportID, 0, "personal", "会话", 1, 1700000100)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO generation_turns (session_id, status, protocol, model, created_at)
		 VALUES (?, 'working', 'openai-compatible', 'm', 1700000200)`, sessionID,
	); err != nil {
		t.Fatalf("seed turn: %v", err)
	}

	rec := h.do(http.MethodDelete, "/api/reports/"+itoa(reportID)+"/generation-sessions/"+itoa(sessionID), "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"TURN_IN_PROGRESS"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// DELETE 的非法 id 文案是中文（route.ts 的差异点）。
func TestArchiveGenerationSessionInvalidIDMessage(t *testing.T) {
	h := newHarness(t)
	rec := h.do(http.MethodDelete, "/api/reports/abc/generation-sessions/1", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !contains(rec.Body.String(), `"error":"无效的ID"`) || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}

	rec = h.do(http.MethodDelete, "/api/reports/1/generation-sessions/999", "")
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"SESSION_NOT_FOUND"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
