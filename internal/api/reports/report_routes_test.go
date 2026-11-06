package reports_test

import (
	"encoding/json"
	"net/http"
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

	rec := h.do(http.MethodPost, "/api/reports/preview", `{"weekStart":"2024-01-08","weekEnd":"2024-01-14"}`)
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

	rec := h.do(http.MethodPost, "/api/reports/preview", `{"weekStart":"2024-01-20","weekEnd":"2024-01-14"}`)
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
		`{"weekStart":"`+weekStart.Format("2006-01-02")+`","weekEnd":"`+weekEnd.Format("2006-01-02")+`"}`)
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
	weekStart := time.Date(2024, 1, 8, 0, 0, 0, 0, time.Local)
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
	rec = h.do(http.MethodGet, "/api/reports/search?startDate=2024-01-08&endDate=2024-01-14", "")
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
