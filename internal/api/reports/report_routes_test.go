package reports_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"
)

// 用例集逐条对照 src/app/api/reports/preview/route.test.ts，其余路由无现有
// route.test：httptest 补 happy path + {error, code} 错误形状（票面要求）。

func TestPreviewReturnsBothSourceDrafts(t *testing.T) {
	h := newHarness(t)
	h.seedCollectSource("work-repo", "work")
	h.seedEvent(1705000000, "manual", "工作事项", "")
	h.seedEvent(1705000001, "manual", "个人事项", "")

	rec := h.do(http.MethodPost, "/api/reports/preview", `{"weekStart":"2024-01-08T00:00:00+00:00","weekEnd":"2024-01-14T00:00:00+00:00"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Variants []struct {
			Variant     string `json:"variant"`
			SourceDraft string `json:"sourceDraft"`
		} `json:"variants"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if len(body.Variants) != 2 {
		t.Fatalf("variants = %d, want 2", len(body.Variants))
	}
	if body.Variants[0].Variant != "leadership" || body.Variants[1].Variant != "personal" {
		t.Fatalf("variant order = %q/%q", body.Variants[0].Variant, body.Variants[1].Variant)
	}
	if !contains(body.Variants[1].SourceDraft, "工作事项") || !contains(body.Variants[1].SourceDraft, "个人事项") {
		t.Fatalf("personal draft = %q", body.Variants[1].SourceDraft)
	}

	// 预览不创建报告。
	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM reports`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("reports = %d, want 0", count)
	}
}

func TestPreviewRejectsInvalidDateRange(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/reports/preview", `{"weekStart":"2024-01-20T00:00:00+00:00","weekEnd":"2024-01-14T00:00:00+00:00"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"VALIDATION_ERROR"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPreviewHandlesMalformedBody(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/reports/preview", `{`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"PREVIEW_ERROR"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// 原稿按来源分组（ADR-0004 的项目范围）：手动事件排最前，仓库条目带缩进。
func TestPreviewBuildsOriginRankedDraft(t *testing.T) {
	h := newHarness(t)
	workSource := h.seedCollectSource("work-repo", "work")
	personalSource := h.seedCollectSource("personal-repo", "personal")
	h.seedEvent(1705000000, "manual", "手动重点", "")
	h.seedEvent(1705000001, "git-remote-github", "工作提交", `{"sourceId":`+itoa(workSource)+`,"repo":"work-repo"}`)
	h.seedEvent(1705000002, "git-remote-github", "个人提交", `{"sourceId":`+itoa(personalSource)+`,"repo":"personal-repo"}`)

	// 2024-01-08 00:00 本地时区起算，事件时间取同周内的固定时刻。
	weekStart := time.Date(2024, 1, 8, 0, 0, 0, 0, time.Local)
	weekEnd := time.Date(2024, 1, 14, 23, 59, 59, 0, time.Local)
	h.seedEvent(weekStart.Unix()+3600, "manual", "周内手动", "")
	h.seedEvent(weekStart.Unix()+7200, "git-remote-github", "周内提交", `{"sourceId":`+itoa(workSource)+`,"repo":"work-repo"}`)
	_ = weekEnd

	rec := h.do(http.MethodPost, "/api/reports/preview",
		`{"weekStart":"`+weekStart.Format(time.RFC3339)+`","weekEnd":"`+weekEnd.Format(time.RFC3339)+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Variants []struct {
			Variant     string `json:"variant"`
			SourceDraft string `json:"sourceDraft"`
		} `json:"variants"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	leadership := body.Variants[0].SourceDraft
	personal := body.Variants[1].SourceDraft
	if !contains(leadership, "- **work-repo**") {
		t.Fatalf("leadership draft = %q, want repo group", leadership)
	}
	if contains(leadership, "personal-repo") {
		t.Fatalf("leadership draft = %q, must not include personal repo", leadership)
	}
	if !contains(personal, "personal-repo") {
		t.Fatalf("personal draft = %q, want personal repo", personal)
	}
	// 手动组（rank 0）在 work 组（rank 1）之前。
	if indexOf(personal, "周内手动") > indexOf(personal, "work-repo") {
		t.Fatalf("personal draft = %q, want manual before work repo", personal)
	}
}

func TestGetReportReturnsBundle(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "legacy", "2024-01-08", "2024-01-14", 1705310800)
	h.seedVariant(reportID, "leadership", "- 领导版", nil, 3, nil)
	final := "个人版终版"
	h.seedVariant(reportID, "personal", "- 个人版", &final, 3, nil)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO report_event_snapshots (report_id, raw_event_id, event_time, source, content, leadership_included, personal_included, source_revision, created_at)
		 VALUES (?, 1, 1705000000, 'manual', '手动', 1, 1, 3, 1705000000)`, reportID,
	); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	// 更旧版本的快照不应出现在 bundle 里（currentRevision=3）。
	if _, err := h.sqlDB.Exec(
		`INSERT INTO report_event_snapshots (report_id, raw_event_id, event_time, source, content, leadership_included, personal_included, source_revision, created_at)
		 VALUES (?, 2, 1705000001, 'manual', '旧版本', 1, 1, 1, 1705000001)`, reportID,
	); err != nil {
		t.Fatalf("seed old snapshot: %v", err)
	}

	rec := h.do(http.MethodGet, "/api/reports/"+itoa(reportID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		ID       int64  `json:"id"`
		Content  string `json:"content"`
		Variants []struct {
			Variant        string `json:"variant"`
			SourceRevision int64  `json:"sourceRevision"`
		} `json:"variants"`
		Snapshots []struct {
			Content string `json:"content"`
		} `json:"snapshots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.ID != reportID || body.Content != final {
		t.Fatalf("body = %+v", body)
	}
	if len(body.Variants) != 2 {
		t.Fatalf("variants = %d, want 2", len(body.Variants))
	}
	if len(body.Snapshots) != 1 || body.Snapshots[0].Content != "手动" {
		t.Fatalf("snapshots = %+v, want only current revision", body.Snapshots)
	}
}

// legacy 报告（无变体）返回一个伪造的个人版变体，sourceRevision=0（e2e 断言）。
func TestGetLegacyReportReturnsSyntheticVariant(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("旧版报告", "Original legacy final", "2024-01-08", "2024-01-14", 1705310800)

	rec := h.do(http.MethodGet, "/api/reports/"+itoa(reportID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Content  string `json:"content"`
		Variants []struct {
			ID             int64  `json:"id"`
			Variant        string `json:"variant"`
			SourceDraft    string `json:"sourceDraft"`
			FinalContent   string `json:"finalContent"`
			FinalStatus    string `json:"finalStatus"`
			SourceRevision int64  `json:"sourceRevision"`
		} `json:"variants"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if len(body.Variants) != 1 {
		t.Fatalf("variants = %d, want 1", len(body.Variants))
	}
	variant := body.Variants[0]
	if variant.ID != -reportID || variant.Variant != "personal" || variant.SourceRevision != 0 {
		t.Fatalf("synthetic variant = %+v", variant)
	}
	if variant.SourceDraft != "- No events this week" || variant.FinalContent != "Original legacy final" || variant.FinalStatus != "current" {
		t.Fatalf("synthetic variant = %+v", variant)
	}
	if body.Content != "Original legacy final" {
		t.Fatalf("content = %q", body.Content)
	}
}

func TestGetReportErrorShapes(t *testing.T) {
	h := newHarness(t)

	cases := []struct {
		path   string
		status int
		code   string
	}{
		{"/api/reports/abc", http.StatusBadRequest, "INVALID_ID"},
		{"/api/reports/999", http.StatusNotFound, "NOT_FOUND"},
	}
	for _, tc := range cases {
		rec := h.do(http.MethodGet, tc.path, "")
		if rec.Code != tc.status {
			t.Fatalf("%s status = %d, want %d", tc.path, rec.Code, tc.status)
		}
		if !contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
			t.Fatalf("%s body = %s", tc.path, rec.Body.String())
		}
	}
}

func TestUpdateReportTitle(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("原标题", "content", "2024-01-08", "2024-01-14", 1705310800)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID), `{"title":"  新标题  "}`)
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

	// 空白标题保持原值（route.ts 的 `body.title.trim() ? ... : existing.title`）。
	rec = h.do(http.MethodPut, "/api/reports/"+itoa(reportID), `{"title":"   "}`)
	var unchanged struct {
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &unchanged); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if unchanged.Title != "新标题" {
		t.Fatalf("title = %q, want unchanged 新标题", unchanged.Title)
	}
}

func TestUpdateReportErrorShapes(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPut, "/api/reports/abc", `{"title":"x"}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("invalid id: status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPut, "/api/reports/999", `{"title":"x"}`)
	if rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("missing: status=%d body=%s", rec.Code, rec.Body.String())
	}

	h.seedReport("报告", "c", "2024-01-08", "2024-01-14", 1705310800)
	rec = h.do(http.MethodPut, "/api/reports/1", `not-json`)
	if rec.Code != http.StatusInternalServerError || !contains(rec.Body.String(), `"code":"UPDATE_ERROR"`) {
		t.Fatalf("malformed: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDeleteReportCascades(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "content", "2024-01-08", "2024-01-14", 1705310800)
	sessionID := h.seedSession(reportID, 0, "personal", "会话", 1, 1700000500)
	h.seedVariant(reportID, "personal", "- 原稿", nil, 1, nil)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO report_event_snapshots (report_id, raw_event_id, event_time, source, content, leadership_included, personal_included, source_revision, created_at)
		 VALUES (?, 1, 1705000000, 'manual', '手动', 1, 1, 1, 1705000000)`, reportID,
	); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, created_at)
		 VALUES (?, NULL, 1, 'system', 'text', 'x', 1700000300)`, sessionID,
	); err != nil {
		t.Fatalf("seed part: %v", err)
	}

	rec := h.do(http.MethodDelete, "/api/reports/"+itoa(reportID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("body = %s", rec.Body.String())
	}

	for _, table := range []string{"reports", "report_variants", "report_event_snapshots", "generation_sessions", "generation_message_parts"} {
		var count int
		if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count != 0 {
			t.Fatalf("%s rows = %d, want 0", table, count)
		}
	}
}

// 有已接受提案的报告拒绝删除（409 AUDIT_RECORD_REQUIRED，文案照抄）。
func TestDeleteReportRejectsAcceptedProposal(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "content", "2024-01-08", "2024-01-14", 1705310800)
	sessionID := h.seedSession(reportID, 0, "personal", "会话", 1, 1700000500)
	h.seedProposal(sessionID, "accepted", 1, 1700000400)

	rec := h.do(http.MethodDelete, "/api/reports/"+itoa(reportID), "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"AUDIT_RECORD_REQUIRED"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if !contains(rec.Body.String(), "Keep the report or archive its sessions first.") {
		t.Fatalf("body = %s", rec.Body.String())
	}

	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM reports`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("reports = %d, want 1 (not deleted)", count)
	}
}

func TestDeleteReportErrorShapes(t *testing.T) {
	h := newHarness(t)
	if rec := h.do(http.MethodDelete, "/api/reports/abc", ""); rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("invalid id: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.do(http.MethodDelete, "/api/reports/999", ""); rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("missing: %d %s", rec.Code, rec.Body.String())
	}
}

// regenerate-source 版本号 +1，旧终版标 stale，报告 content 写回个人版原稿。
func TestRegenerateSourceBumpsRevision(t *testing.T) {
	h := newHarness(t)
	// regenerate-source has no client offset, so the window is folded in UTC;
	// seed the event inside that deterministic window.
	weekStart := time.Date(2024, 1, 8, 0, 0, 0, 0, time.UTC)
	reportID := h.seedReport("报告", "旧内容", weekStart.Format("2006-01-02"), "2024-01-14", 1705310800)
	final := "旧终版"
	h.seedVariant(reportID, "leadership", "- 旧原稿", &final, 1, nil)
	h.seedVariant(reportID, "personal", "- 旧原稿", nil, 1, nil)
	h.seedEvent(weekStart.Unix()+3600, "manual", "周内事件", "")

	rec := h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/regenerate-source", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Content  string `json:"content"`
		Variants []struct {
			Variant        string `json:"variant"`
			SourceDraft    string `json:"sourceDraft"`
			FinalStatus    string `json:"finalStatus"`
			SourceRevision int64  `json:"sourceRevision"`
		} `json:"variants"`
		Snapshots []struct {
			SourceRevision int64  `json:"sourceRevision"`
			Content        string `json:"content"`
		} `json:"snapshots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	for _, variant := range body.Variants {
		if variant.SourceRevision != 2 {
			t.Fatalf("%s revision = %d, want 2", variant.Variant, variant.SourceRevision)
		}
		if !contains(variant.SourceDraft, "周内事件") {
			t.Fatalf("%s draft = %q", variant.Variant, variant.SourceDraft)
		}
	}
	if body.Variants[0].FinalStatus != "stale" {
		t.Fatalf("leadership finalStatus = %q, want stale", body.Variants[0].FinalStatus)
	}
	if body.Variants[1].FinalStatus != "none" {
		t.Fatalf("personal finalStatus = %q, want none", body.Variants[1].FinalStatus)
	}
	if len(body.Snapshots) != 1 || body.Snapshots[0].SourceRevision != 2 {
		t.Fatalf("snapshots = %+v", body.Snapshots)
	}
	// reports.content 写回个人版原稿。
	if body.Content != body.Variants[1].SourceDraft {
		t.Fatalf("content = %q, want %q", body.Content, body.Variants[1].SourceDraft)
	}
}

func TestRegenerateSourceErrorShapes(t *testing.T) {
	h := newHarness(t)
	if rec := h.do(http.MethodPost, "/api/reports/abc/regenerate-source", ""); rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `"code":"INVALID_ID"`) {
		t.Fatalf("invalid id: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.do(http.MethodPost, "/api/reports/999/regenerate-source", ""); rec.Code != http.StatusNotFound || !contains(rec.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("missing: %d %s", rec.Code, rec.Body.String())
	}
}

// search 按标题/正文/变体原稿做大小写不敏感匹配，并支持日期区间过滤。
func TestSearchReports(t *testing.T) {
	h := newHarness(t)
	first := h.seedReport("Alpha 周报", "普通内容", "2024-01-01", "2024-01-07", 1704704400)
	h.seedReport("Beta 周报", "special keyword", "2024-01-08", "2024-01-14", 1705310800)
	h.seedVariant(first, "personal", "- 原稿里的 NEEDLE", nil, 1, nil)

	rec := h.do(http.MethodGet, "/api/reports/search?q=needle", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Reports []struct {
			ID       int64  `json:"id"`
			Title    string `json:"title"`
			Variants []any  `json:"variants"`
		} `json:"reports"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Reports) != 1 || body.Reports[0].ID != first {
		t.Fatalf("reports = %+v, want only the variant hit", body.Reports)
	}
	if body.Reports[0].Variants == nil {
		t.Fatalf("variants = null, want [] or list")
	}

	rec = h.do(http.MethodGet, "/api/reports/search?q=SPECIAL", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Reports) != 1 || body.Reports[0].Title != "Beta 周报" {
		t.Fatalf("reports = %+v, want Beta", body.Reports)
	}

	// 日期过滤：weekStart < startDate 或 weekEnd > endDate 都被排除。
	rec = h.do(http.MethodGet, "/api/reports/search?startDate=2024-01-08T00:00:00Z&endDate=2024-01-14T00:00:00Z", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Reports) != 1 || body.Reports[0].Title != "Beta 周报" {
		t.Fatalf("reports = %+v, want only Beta", body.Reports)
	}

	// 无 q 时返回全部。
	rec = h.do(http.MethodGet, "/api/reports/search", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Reports) != 2 {
		t.Fatalf("reports = %d, want 2", len(body.Reports))
	}
}

func TestSearchReportsErrorShape(t *testing.T) {
	h := newHarness(t)
	h.breakDB()
	rec := h.do(http.MethodGet, "/api/reports/search", "")
	if rec.Code != http.StatusInternalServerError || !contains(rec.Body.String(), `"code":"SEARCH_ERROR"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// raw_events.metadata 是 drizzle 的 json mode 列：非法 JSON 在 TS 里让
// findEventsForWeek 在查询期抛错 → route.ts 的 catch → 500。preview / create /
// regenerate-source 三条原稿入口都要复刻这一行为，不能把损坏事件静默当成
// 无来源的手动事件。
func TestSourceDraftRoutesRejectCorruptEventMetadata(t *testing.T) {
	h := newHarness(t)
	h.seedEvent(1705000000, "git-remote-github", "损坏元数据", `{"sourceId":`)

	rec := h.do(http.MethodPost, "/api/reports/preview", `{"weekStart":"2024-01-08T00:00:00+00:00","weekEnd":"2024-01-14T00:00:00+00:00"}`)
	if rec.Code != http.StatusInternalServerError || !contains(rec.Body.String(), `"code":"PREVIEW_ERROR"`) {
		t.Fatalf("preview: %d %s", rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, "/api/reports", `{"title":"周报","weekStart":"2024-01-08T00:00:00+00:00","weekEnd":"2024-01-14T00:00:00+00:00"}`)
	if rec.Code != http.StatusInternalServerError || !contains(rec.Body.String(), `"code":"CREATE_ERROR"`) {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM reports`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("reports = %d, want 0 (corrupt metadata must abort before insert)", count)
	}

	reportID := h.seedReport("周报", "", "2024-01-08", "2024-01-14", 1705000100)
	rec = h.do(http.MethodPost, "/api/reports/"+itoa(reportID)+"/regenerate-source", "")
	if rec.Code != http.StatusInternalServerError || !contains(rec.Body.String(), `"code":"REGENERATE_ERROR"`) {
		t.Fatalf("regenerate: %d %s", rec.Code, rec.Body.String())
	}
}

// wire 上的日期/周界参数只认 RFC3339 带偏移；date-only 一律 400，且信息里
// 给出可复制的格式示例。
func TestReportDateParamsRejectDateOnly(t *testing.T) {
	h := newHarness(t)

	preview := h.do(http.MethodPost, "/api/reports/preview",
		`{"weekStart":"2024-01-08","weekEnd":"2024-01-14"}`)
	if preview.Code != http.StatusBadRequest {
		t.Fatalf("preview status = %d, want 400 (body %s)", preview.Code, preview.Body.String())
	}
	for _, want := range []string{"Date must be an RFC3339 timestamp with an offset", "2026-11-03T00:00:00+08:00"} {
		if !contains(preview.Body.String(), want) {
			t.Fatalf("preview body = %s, want %q", preview.Body.String(), want)
		}
	}

	create := h.do(http.MethodPost, "/api/reports",
		`{"title":"x","weekStart":"2024-01-08","weekEnd":"2024-01-14"}`)
	if create.Code != http.StatusBadRequest {
		t.Fatalf("create status = %d, want 400 (body %s)", create.Code, create.Body.String())
	}
	if !contains(create.Body.String(), "2026-11-03T00:00:00+08:00") {
		t.Fatalf("create body = %s, want the format example", create.Body.String())
	}

	search := h.do(http.MethodGet, "/api/reports/search?startDate=2024-01-08", "")
	if search.Code != http.StatusBadRequest {
		t.Fatalf("search status = %d, want 400 (body %s)", search.Code, search.Body.String())
	}
	if !contains(search.Body.String(), "startDate must be an RFC3339 timestamp with an offset") ||
		!contains(search.Body.String(), "2026-11-03T00:00:00+08:00") {
		t.Fatalf("search body = %s", search.Body.String())
	}

	badEnd := h.do(http.MethodGet, "/api/reports/search?endDate=not-a-date", "")
	if badEnd.Code != http.StatusBadRequest || !contains(badEnd.Body.String(), "endDate must be an RFC3339 timestamp") {
		t.Fatalf("search endDate status = %d body = %s", badEnd.Code, badEnd.Body.String())
	}
}

// 搜索把入参按请求偏移折成 date-only 周期键，再沿用既有字符串比较。
// 若错误地按 UTC 取日期，+08 零点会折到前一天，下面的 inclusive/exclusive
// 断言就会翻转。
func TestSearchFoldsDatesByRequestOffset(t *testing.T) {
	h := newHarness(t)
	h.seedReport("第 2 周", "", "2024-01-08", "2024-01-14", 1705310800)

	// endDate 是 +08 的 01-14 零点：折键后等于 weekEnd，应保留。
	rec := h.do(http.MethodGet,
		"/api/reports/search?startDate=2024-01-08T00:00:00%2B08:00&endDate=2024-01-14T00:00:00%2B08:00", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), "第 2 周") {
		t.Fatalf("body = %s, want the report included", rec.Body.String())
	}

	// startDate 是 +08 的 01-09 零点：折键后晚于 weekStart，应排除。
	rec = h.do(http.MethodGet, "/api/reports/search?startDate=2024-01-09T00:00:00%2B08:00", "")
	if !contains(rec.Body.String(), `"reports":[]`) {
		t.Fatalf("body = %s, want the report excluded", rec.Body.String())
	}
}

// 折键取请求偏移的墙钟日，而不是 UTC 投影日：半时区与跨年边界都不能把键
// 挪到相邻一天。报告键与该墙钟日相同，只有折键精确命中时才会保留。
func TestSearchDateKeyFoldingMatrix(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name  string
		input string
		key   string
	}{
		{"half-hour offset keeps the wall-clock day", "2026-03-10T00:00:00+05:30", "2026-03-10"},
		{"cross-year wall clock beats the UTC projection", "2026-01-01T00:00:00+05:30", "2026-01-01"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			title := "folded-" + tc.key
			h.seedReport(title, "", tc.key, tc.key, 1700000000)
			encoded := url.QueryEscape(tc.input)
			rec := h.do(http.MethodGet,
				"/api/reports/search?startDate="+encoded+"&endDate="+encoded, "")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			if !contains(rec.Body.String(), title) {
				t.Fatalf("body = %s, want %q included for key %s", rec.Body.String(), title, tc.key)
			}
		})
	}
}

// preview 的事件窗口按请求偏移取整，而不是服务器本地：用 -05:00 与进程时区
// 区分开，断言跨零点的两个事件各自归属正确。
func TestPreviewFoldsWeekBoundsByRequestOffset(t *testing.T) {
	h := newHarness(t)
	loc := time.FixedZone("", -5*60*60)
	start := time.Date(2024, 1, 8, 0, 0, 0, 0, loc)
	end := time.Date(2024, 1, 14, 23, 59, 59, 0, loc)

	h.seedEvent(start.Unix()-1, "manual", "BEFORE_START", "")
	h.seedEvent(start.Unix(), "manual", "AT_START", "")
	h.seedEvent(end.Unix(), "manual", "AT_END", "")
	h.seedEvent(end.Unix()+1, "manual", "AFTER_END", "")

	rec := h.do(http.MethodPost, "/api/reports/preview",
		`{"weekStart":"2024-01-08T00:00:00-05:00","weekEnd":"2024-01-14T00:00:00-05:00"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	for _, want := range []string{"AT_START", "AT_END"} {
		if !contains(rec.Body.String(), want) {
			t.Fatalf("body = %s, want %q included", rec.Body.String(), want)
		}
	}
	for _, unwanted := range []string{"BEFORE_START", "AFTER_END"} {
		if contains(rec.Body.String(), unwanted) {
			t.Fatalf("body = %s, want %q excluded", rec.Body.String(), unwanted)
		}
	}
}

// 周期键的存储与响应保持 date-only 文本：带偏移的入参只影响窗口，不改变键。
func TestCreateStoresDateOnlyPeriodKeys(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/reports",
		`{"title":"第 2 周","weekStart":"2024-01-08T00:00:00-05:00","weekEnd":"2024-01-14T00:00:00-05:00"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Report struct {
			WeekStart string `json:"weekStart"`
			WeekEnd   string `json:"weekEnd"`
		} `json:"report"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.Report.WeekStart != "2024-01-08" || body.Report.WeekEnd != "2024-01-14" {
		t.Fatalf("week keys = %q~%q, want date-only", body.Report.WeekStart, body.Report.WeekEnd)
	}
}
