package e2e_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

const fixturesPath = "/api/e2e/fixtures"

// 门控（ADR-0029）：未设 E2E_FIXTURES=1 时两条方法都回 404 + {error:"Not found"}
// （没有 code，与业务错误不同）。
func TestFixturesDisabledReturns404(t *testing.T) {
	h := newHarness(t)
	t.Setenv("E2E_FIXTURES", "")

	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		rec := h.authed(method, fixturesPath, `{"action":"historical","marker":"m"}`)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404 (body %s)", method, rec.Code, rec.Body.String())
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"error":"Not found"}` {
			t.Fatalf("%s body = %s, want {\"error\":\"Not found\"}", method, got)
		}
	}

	// 门控关闭时不允许写库。
	if n := h.countRows(`SELECT COUNT(*) FROM reports`); n != 0 {
		t.Fatalf("reports = %d, want 0", n)
	}
}

// 门控只在 E2E_FIXTURES 严格等于 "1" 时打开。
func TestFixturesGateRequiresExactOne(t *testing.T) {
	h := newHarness(t)
	for _, value := range []string{"true", "0", "yes", " 1", "01"} {
		t.Setenv("E2E_FIXTURES", value)
		rec := h.authed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"m"}`)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("E2E_FIXTURES=%q: status = %d, want 404", value, rec.Code)
		}
	}
}

// withAuth：鉴权在门控外层（与 TS 的 withAuth(HOF) 同序），401 形状与守卫一致。
func TestFixturesRequiresAuth(t *testing.T) {
	h := newHarness(t)

	t.Setenv("E2E_FIXTURES", "1")
	rec := h.do(http.MethodPost, fixturesPath, `{"action":"historical","marker":"m"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"error":"Unauthorized"}` {
		t.Fatalf("body = %s, want {\"error\":\"Unauthorized\"}", got)
	}

	// 门控关闭、无凭证 → 仍是 401：鉴权先于门控。
	t.Setenv("E2E_FIXTURES", "")
	rec = h.do(http.MethodDelete, fixturesPath, `{}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("gated-off anonymous status = %d, want 401", rec.Code)
	}

	// 带密码 → 通过鉴权，进入业务分支。
	t.Setenv("E2E_FIXTURES", "1")
	h.mustAuthed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"m"}`, http.StatusCreated)
}

// 输入校验：与 route.ts 同一条 400 INVALID_INPUT。
func TestFixturesPostValidation(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	cases := []struct {
		name string
		body string
	}{
		{"no body", ""},
		{"invalid json", `not-json`},
		{"trailing garbage", `{"action":"historical","marker":"m"} extra`},
		{"null body", `null`},
		{"array body", `[]`},
		{"number body", `5`},
		{"missing action", `{"marker":"m"}`},
		{"unknown action", `{"action":"other","marker":"m"}`},
		{"null action", `{"action":null,"marker":"m"}`},
		{"numeric action", `{"action":7,"marker":"m"}`},
		{"missing marker", `{"action":"historical"}`},
		{"null marker", `{"action":"historical","marker":null}`},
		{"numeric marker", `{"action":"historical","marker":5}`},
		{"empty marker", `{"action":"historical","marker":""}`},
		{"whitespace marker", `{"action":"historical","marker":" \t\n"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.authed(http.MethodPost, fixturesPath, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			body := h.decode(rec)
			if body["error"] != "A marker and historical action are required" || body["code"] != "INVALID_INPUT" {
				t.Fatalf("body = %#v", body)
			}
		})
	}

	if n := h.countRows(`SELECT COUNT(*) FROM reports`); n != 0 {
		t.Fatalf("reports = %d, want 0", n)
	}
}

// action=historical 的响应形状与落库内容。
func TestFixturesHistoricalShape(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	rec := h.mustAuthed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"  my-marker  "}`, http.StatusCreated)

	body := h.decode(rec)
	reports, ok := body["reports"].([]any)
	if !ok || len(reports) != 3 {
		t.Fatalf("reports = %#v, want 3 elements", body["reports"])
	}

	wantKinds := []string{"current", "stale", "legacy"}
	wantWeeks := [][2]string{
		{"2026-12-21", "2026-12-27"},
		{"2026-12-14", "2026-12-20"},
		{"2026-12-07", "2026-12-13"},
	}
	ids := make([]int64, 0, 3)
	for index, item := range reports {
		entry, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("reports[%d] = %#v", index, item)
		}
		id, ok := entry["id"].(float64)
		if !ok || id <= 0 {
			t.Fatalf("reports[%d].id = %#v", index, entry["id"])
		}
		if entry["kind"] != wantKinds[index] {
			t.Fatalf("reports[%d].kind = %#v, want %q", index, entry["kind"], wantKinds[index])
		}
		ids = append(ids, int64(id))

		var title, content, weekStart, weekEnd string
		if err := h.sqlDB.QueryRow(
			`SELECT title, content, week_start, week_end FROM reports WHERE id = ?`, int64(id),
		).Scan(&title, &content, &weekStart, &weekEnd); err != nil {
			t.Fatalf("read report %d: %v", int64(id), err)
		}
		if weekStart != wantWeeks[index][0] || weekEnd != wantWeeks[index][1] {
			t.Fatalf("reports[%d] weeks = %s..%s, want %s..%s", index, weekStart, weekEnd, wantWeeks[index][0], wantWeeks[index][1])
		}
		if index < 2 {
			if want := "my-marker " + wantKinds[index] + " history"; title != want {
				t.Fatalf("reports[%d] title = %q, want %q", index, title, want)
			}
			if want := "# " + wantKinds[index] + " history"; content != want {
				t.Fatalf("reports[%d] content = %q, want %q", index, content, want)
			}
			if n := h.countRows(`SELECT COUNT(*) FROM report_variants WHERE report_id = ?`, int64(id)); n != 2 {
				t.Fatalf("reports[%d] variants = %d, want 2", index, n)
			}
		} else {
			if want := "my-marker legacy history"; title != want {
				t.Fatalf("legacy title = %q, want %q", title, want)
			}
			if want := "# my-marker legacy final"; content != want {
				t.Fatalf("legacy content = %q, want %q", content, want)
			}
			if n := h.countRows(`SELECT COUNT(*) FROM report_variants WHERE report_id = ?`, int64(id)); n != 0 {
				t.Fatalf("legacy variants = %d, want 0", n)
			}
		}
	}

	// current 报告的 variants 字段形状：leadership 先、personal 后（数组顺序）。
	rows, err := h.sqlDB.Query(
		`SELECT variant, source_draft, final_content, final_status, accepted_proposal_id, source_revision
		 FROM report_variants WHERE report_id = ? ORDER BY id`, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	wantVariants := []struct {
		variant     string
		sourceDraft string
		final       string
		status      string
	}{
		{"leadership", "- my-marker leadership source", "# my-marker leadership final", "current"},
		{"personal", "- my-marker personal source", "# my-marker personal final", "current"},
	}
	index := 0
	for rows.Next() {
		var variant, sourceDraft, finalContent, status string
		var acceptedProposalID *int64
		var revision int64
		if err := rows.Scan(&variant, &sourceDraft, &finalContent, &status, &acceptedProposalID, &revision); err != nil {
			t.Fatal(err)
		}
		want := wantVariants[index]
		if variant != want.variant || sourceDraft != want.sourceDraft || finalContent != want.final || status != want.status {
			t.Fatalf("variant[%d] = %q/%q/%q/%q", index, variant, sourceDraft, finalContent, status)
		}
		if acceptedProposalID != nil {
			t.Fatalf("variant[%d] accepted_proposal_id = %v, want NULL", index, *acceptedProposalID)
		}
		if revision != 1 {
			t.Fatalf("variant[%d] source_revision = %d, want 1", index, revision)
		}
		index++
	}
	if index != 2 {
		t.Fatalf("read %d variants, want 2", index)
	}
}

// marker 按 JS trim 后 slice(0,120) 截断。
func TestFixturesMarkerTrimAndSlice(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	marker := "  " + strings.Repeat("a", 120) + "TAIL  "
	rec := h.mustAuthed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"`+marker+`"}`, http.StatusCreated)
	body := h.decode(rec)
	firstID := int64(body["reports"].([]any)[0].(map[string]any)["id"].(float64))

	var title string
	if err := h.sqlDB.QueryRow(`SELECT title FROM reports WHERE id = ?`, firstID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if want := strings.Repeat("a", 120) + " current history"; title != want {
		t.Fatalf("title = %q, want %q", title, want)
	}
}

// action=report-query（standard）的响应形状、相对周与 variants 内容。
func TestFixturesReportQueryShape(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	targetID := h.seedReport("target", "2026-12-21", "2026-12-27")
	rec := h.mustAuthed(http.MethodPost, fixturesPath,
		`{"action":"report-query","marker":"q","targetReportId":`+strconv.FormatInt(targetID, 10)+`}`, http.StatusCreated)

	body := h.decode(rec)
	reportIDs := h.numberList(body, "reportIds")
	// 9 条：previous adjacent + 6 个变体报告 + legacy readable + none + unaccepted
	// 里除 legacy readable 之外都走 createReport；实际顺序见下。
	if len(reportIDs) != 9 {
		t.Fatalf("reportIds = %v, want 9 ids", reportIDs)
	}

	adjacent := h.number(body, "adjacentReportId")
	sameAudience := h.number(body, "sameAudienceReportId")
	crossAudience := h.number(body, "crossAudienceReportId")
	longReport := h.number(body, "longReportId")
	currentLegacy := h.number(body, "currentLegacyReportId")
	stale := h.number(body, "staleReportId")
	legacy := h.number(body, "legacyReportId")
	none := h.number(body, "noneReportId")
	unaccepted := h.number(body, "unacceptedReportId")

	// reportIds 的顺序 = route.ts 的 push 顺序（legacy readable 在 none 之前）。
	wantOrder := []int64{adjacent, sameAudience, crossAudience, longReport, currentLegacy, stale, legacy, none, unaccepted}
	for index, want := range wantOrder {
		if reportIDs[index] != want {
			t.Fatalf("reportIds[%d] = %d, want %d (all %v)", index, reportIDs[index], want, reportIDs)
		}
	}

	// 相对周：目标 2026-12-21 起算，按本地日历日平移。
	weekCases := []struct {
		id        int64
		title     string
		weekStart string
		weekEnd   string
	}{
		{adjacent, "q previous adjacent", "2026-12-14", "2026-12-20"},
		{sameAudience, "q personal history", "2026-11-30", "2026-12-06"},
		{crossAudience, "q leadership only", "2026-12-07", "2026-12-13"},
		{longReport, "q long content", "2026-10-19", "2026-10-25"},
		{currentLegacy, "q legacy current excluded", "2026-11-02", "2026-11-08"},
		{stale, "q stale excluded", "2026-11-23", "2026-11-29"},
		{legacy, "q legacy readable", "2026-10-26", "2026-11-01"},
		{none, "q none excluded", "2026-11-16", "2026-11-22"},
		{unaccepted, "q unaccepted excluded", "2026-11-09", "2026-11-15"},
	}
	for _, tc := range weekCases {
		var title, content, weekStart, weekEnd string
		if err := h.sqlDB.QueryRow(
			`SELECT title, content, week_start, week_end FROM reports WHERE id = ?`, tc.id,
		).Scan(&title, &content, &weekStart, &weekEnd); err != nil {
			t.Fatalf("read report %d: %v", tc.id, err)
		}
		if title != tc.title {
			t.Fatalf("report %d title = %q, want %q", tc.id, title, tc.title)
		}
		if weekStart != tc.weekStart || weekEnd != tc.weekEnd {
			t.Fatalf("report %d weeks = %s..%s, want %s..%s", tc.id, weekStart, weekEnd, tc.weekStart, tc.weekEnd)
		}
		// reports.content 是私有正文：legacy readable 之外一律带 raw source 前缀。
		if tc.id != legacy {
			if want := "# raw source must stay private: " + tc.title; content != want {
				t.Fatalf("report %d content = %q, want %q", tc.id, content, want)
			}
		} else if want := "# q legacy readable content\n\nq legacy grep target"; content != want {
			t.Fatalf("legacy content = %q, want %q", content, want)
		}
	}

	// accepted proposal id = report.id*100 + index + 1；未 accepted 的是 NULL。
	acceptedCases := []struct {
		reportID int64
		variant  string
		accepted bool
		index    int64
		status   string
	}{
		{adjacent, "personal", true, 0, "current"},
		{adjacent, "leadership", true, 1, "current"},
		{sameAudience, "personal", true, 0, "current"},
		{sameAudience, "leadership", false, 1, "none"},
		{crossAudience, "leadership", true, 0, "current"},
		{crossAudience, "personal", false, 1, "none"},
		{longReport, "personal", true, 0, "current"},
		{currentLegacy, "personal", false, 0, "current"},
		{stale, "personal", true, 0, "stale"},
		{stale, "leadership", true, 1, "stale"},
		{none, "personal", false, 0, "none"},
		{none, "leadership", false, 1, "none"},
		{unaccepted, "personal", false, 0, "none"},
		{unaccepted, "leadership", false, 1, "none"},
	}
	for _, tc := range acceptedCases {
		var accepted *int64
		var status, sourceDraft string
		if err := h.sqlDB.QueryRow(
			`SELECT accepted_proposal_id, final_status, source_draft FROM report_variants WHERE report_id = ? AND variant = ?`,
			tc.reportID, tc.variant,
		).Scan(&accepted, &status, &sourceDraft); err != nil {
			t.Fatalf("read variant %d/%s: %v", tc.reportID, tc.variant, err)
		}
		if tc.accepted {
			want := tc.reportID*100 + tc.index + 1
			if accepted == nil || *accepted != want {
				t.Fatalf("variant %d/%s accepted = %v, want %d", tc.reportID, tc.variant, accepted, want)
			}
		} else if accepted != nil {
			t.Fatalf("variant %d/%s accepted = %v, want NULL", tc.reportID, tc.variant, *accepted)
		}
		if status != tc.status {
			t.Fatalf("variant %d/%s status = %q, want %q", tc.reportID, tc.variant, status, tc.status)
		}
		if want := "- private " + tc.variant + " source draft for "; !strings.HasPrefix(sourceDraft, want) {
			t.Fatalf("variant %d/%s source_draft = %q, want prefix %q", tc.reportID, tc.variant, sourceDraft, want)
		}
	}

	// legacy readable 没有 variants。
	if n := h.countRows(`SELECT COUNT(*) FROM report_variants WHERE report_id = ?`, legacy); n != 0 {
		t.Fatalf("legacy variants = %d, want 0", n)
	}

	// long content 的长度：'# q long content\n\n' + 41000 个 x。
	var longContent string
	if err := h.sqlDB.QueryRow(`SELECT final_content FROM report_variants WHERE report_id = ? AND variant = 'personal'`, longReport).Scan(&longContent); err != nil {
		t.Fatal(err)
	}
	if want := "# q long content\n\n" + strings.Repeat("x", 41_000); longContent != want {
		t.Fatalf("long content len = %d, want %d", len(longContent), len(want))
	}
}

// mode=no-adjacent：不造相邻报告，响应里没有 adjacentReportId 键。
func TestFixturesReportQueryNoAdjacent(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	targetID := h.seedReport("target", "2026-12-21", "2026-12-27")
	rec := h.mustAuthed(http.MethodPost, fixturesPath,
		`{"action":"report-query","marker":"q","targetReportId":`+strconv.FormatInt(targetID, 10)+`,"mode":"no-adjacent"}`,
		http.StatusCreated)

	body := h.decode(rec)
	if _, present := body["adjacentReportId"]; present {
		t.Fatalf("adjacentReportId must be absent in no-adjacent mode: %#v", body)
	}
	if len(h.numberList(body, "reportIds")) != 8 {
		t.Fatalf("reportIds = %v, want 8 ids", body["reportIds"])
	}
	if h.number(body, "sameAudienceReportId") == 0 {
		t.Fatal("sameAudienceReportId must be set")
	}
}

// targetReportId 校验：非整数/非正 → 400 INVALID_INPUT，不存在 → 404 REPORT_NOT_FOUND。
func TestFixturesReportQueryTargetValidation(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	badTargets := []string{`"7"`, `0`, `-1`, `1.5`, `null`, `true`, `[]`, `{}`}
	for _, target := range badTargets {
		rec := h.authed(http.MethodPost, fixturesPath,
			`{"action":"report-query","marker":"q","targetReportId":`+target+`}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("targetReportId=%s: status = %d, want 400 (body %s)", target, rec.Code, rec.Body.String())
		}
		body := h.decode(rec)
		if body["error"] != "A target report ID is required" || body["code"] != "INVALID_INPUT" {
			t.Fatalf("targetReportId=%s: body = %#v", target, body)
		}
	}

	// 缺字段与 missing targetReportId 同为 400。
	rec := h.authed(http.MethodPost, fixturesPath, `{"action":"report-query","marker":"q"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing target: status = %d, want 400", rec.Code)
	}

	// 目标不存在 → 404 REPORT_NOT_FOUND（且不留下任何报告）。
	rec = h.authed(http.MethodPost, fixturesPath, `{"action":"report-query","marker":"q","targetReportId":999}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown target: status = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}
	body := h.decode(rec)
	if body["error"] != "Target report not found" || body["code"] != "REPORT_NOT_FOUND" {
		t.Fatalf("unknown target: body = %#v", body)
	}
	if n := h.countRows(`SELECT COUNT(*) FROM reports`); n != 0 {
		t.Fatalf("reports = %d, want 0", n)
	}
}

// DELETE 清理报告族：variants、event snapshots、生成会话与它们的子表，以及事件。
func TestFixturesDeleteCleansReportsAndEvents(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	seed := h.mustAuthed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"d"}`, http.StatusCreated)
	body := h.decode(seed)
	reportIDs := make([]int64, 0, 3)
	for _, item := range body["reports"].([]any) {
		reportIDs = append(reportIDs, int64(item.(map[string]any)["id"].(float64)))
	}

	// 生成会话族：session → turn / message part / proposal / judgment / override。
	sessionID := h.seedSession(reportIDs[0])
	turnID := h.seedTurn(sessionID)
	h.exec(`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, created_at) VALUES (?, ?, 1, 'user', 'text', 'hi', 0)`, sessionID, turnID)
	h.exec(`INSERT INTO generation_proposals (session_id, turn_id, content, summary, source_revision, created_at) VALUES (?, ?, 'c', '[]', 1, 0)`, sessionID, turnID)
	h.exec(`INSERT INTO generation_plan_judgments (session_id, candidate_id, judgment, reason, created_at) VALUES (?, 'c1', 'accept', 'r', 0)`, sessionID)
	h.exec(`INSERT INTO generation_plan_overrides (session_id, item_id, action, source, created_at) VALUES (?, 'i1', 'add', 'user', 0)`, sessionID)
	h.exec(`INSERT INTO report_event_snapshots (report_id, event_time, source, content, created_at) VALUES (?, 0, 'manual', 'x', 0)`, reportIDs[0])

	eventID := h.seedEvent()

	rec := h.authed(http.MethodDelete, fixturesPath,
		`{"reportIds":[`+joinIDs(reportIDs)+`],"eventIds":[`+strconv.FormatInt(eventID, 10)+`]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := h.number(h.decode(rec), "deleted"); got != 4 {
		t.Fatalf("deleted = %d, want 4 (3 reports + 1 event)", got)
	}

	assertCount := func(label, query string, want int, args ...any) {
		t.Helper()
		if got := h.countRows(query, args...); got != want {
			t.Fatalf("%s = %d, want %d", label, got, want)
		}
	}
	assertCount("reports", `SELECT COUNT(*) FROM reports`, 0)
	assertCount("variants", `SELECT COUNT(*) FROM report_variants`, 0)
	assertCount("snapshots", `SELECT COUNT(*) FROM report_event_snapshots`, 0)
	assertCount("sessions", `SELECT COUNT(*) FROM generation_sessions`, 0)
	assertCount("turns", `SELECT COUNT(*) FROM generation_turns`, 0)
	assertCount("parts", `SELECT COUNT(*) FROM generation_message_parts`, 0)
	assertCount("proposals", `SELECT COUNT(*) FROM generation_proposals`, 0)
	assertCount("judgments", `SELECT COUNT(*) FROM generation_plan_judgments`, 0)
	assertCount("overrides", `SELECT COUNT(*) FROM generation_plan_overrides`, 0)
	assertCount("raw_events", `SELECT COUNT(*) FROM raw_events`, 0)
}

// DELETE 的输入处理：非数组/非法元素被过滤；两侧都空 → {deleted:0}；
// 只删事件不影响报告。
func TestFixturesDeleteInputHandling(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()

	cases := []string{
		``,
		`null`,
		`[]`,
		`{}`,
		`{"reportIds":[]}`,
		`{"reportIds":"x"}`,
		`{"reportIds":[0,-1,1.5,"x",null,true,{}]}`,
		`{"eventIds":[]}`,
		`not-json`,
	}
	for _, body := range cases {
		rec := h.authed(http.MethodDelete, fixturesPath, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("body %q: status = %d, want 200 (body %s)", body, rec.Code, rec.Body.String())
		}
		if got := h.number(h.decode(rec), "deleted"); got != 0 {
			t.Fatalf("body %q: deleted = %d, want 0", body, got)
		}
	}

	// 只删事件：报告族保持不动。
	seed := h.mustAuthed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"e"}`, http.StatusCreated)
	reports := h.decode(seed)["reports"].([]any)
	eventID := h.seedEvent()

	rec := h.authed(http.MethodDelete, fixturesPath, `{"eventIds":[`+strconv.FormatInt(eventID, 10)+`]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := h.number(h.decode(rec), "deleted"); got != 1 {
		t.Fatalf("deleted = %d, want 1", got)
	}
	if n := h.countRows(`SELECT COUNT(*) FROM reports`); n != len(reports) {
		t.Fatalf("reports = %d, want %d", n, len(reports))
	}
	if n := h.countRows(`SELECT COUNT(*) FROM raw_events`); n != 0 {
		t.Fatalf("raw_events = %d, want 0", n)
	}

	// 不存在的 id 也照样计数（route.ts 回的是过滤后的请求长度）。
	rec = h.authed(http.MethodDelete, fixturesPath, `{"reportIds":[999999]}`)
	if got := h.number(h.decode(rec), "deleted"); got != 1 {
		t.Fatalf("deleted = %d, want 1 for a nonexistent id", got)
	}
}

// 门控关闭时 DELETE 不清理任何东西。
func TestFixturesDeleteGatedOffKeepsData(t *testing.T) {
	h := newHarness(t)
	h.fixturesEnabled()
	h.mustAuthed(http.MethodPost, fixturesPath, `{"action":"historical","marker":"g"}`, http.StatusCreated)

	reportIDs := []int64{1, 2, 3}
	t.Setenv("E2E_FIXTURES", "")
	rec := h.authed(http.MethodDelete, fixturesPath, `{"reportIds":[`+joinIDs(reportIDs)+`]}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if n := h.countRows(`SELECT COUNT(*) FROM reports`); n != 3 {
		t.Fatalf("reports = %d, want 3", n)
	}
}

// 相对周按本地日历移位：用非 UTC 时区跑一遍，确认没有掉进 UTC 解释。
func TestFixturesReportQueryUsesLocalCalendar(t *testing.T) {
	original := time.Local
	time.Local = time.FixedZone("UTC+08", 8*3600)
	t.Cleanup(func() { time.Local = original })

	h := newHarness(t)
	h.fixturesEnabled()

	targetID := h.seedReport("target", "2027-01-04", "2027-01-10")
	h.mustAuthed(http.MethodPost, fixturesPath,
		`{"action":"report-query","marker":"tz","targetReportId":`+strconv.FormatInt(targetID, 10)+`}`, http.StatusCreated)

	// 2027-01-04 减 7 天 = 2026-12-28（跨年）；再减 21 天 = 2026-12-14。
	var weekStart string
	if err := h.sqlDB.QueryRow(
		`SELECT week_start FROM reports WHERE title = 'tz personal history'`,
	).Scan(&weekStart); err != nil {
		t.Fatal(err)
	}
	if want := "2026-12-14"; weekStart != want {
		t.Fatalf("week_start = %q, want %q", weekStart, want)
	}
}

// seedSession / seedTurn / seedEvent / exec / joinIDs 是本文件的小工具。
func (h *harness) seedSession(reportID int64) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO generation_sessions (
			report_id, report_variant_id, variant, title, status, source_revision,
			source_draft_snapshot, source_overview, template_id, template_name, template_content,
			ai_style_key, ai_style_label, ai_style_prompt, temperature, system_prompt, tool_rules,
			created_at, updated_at)
		 VALUES (?, 1, 'personal', 't', 'active', 1, '', '', 'official-general', 'general', '',
		         'formal', 'formal', '', '0.3', '', '', 0, 0)`,
		reportID,
	)
	if err != nil {
		h.t.Fatalf("seed session: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) seedTurn(sessionID int64) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO generation_turns (session_id, status, protocol, model, created_at) VALUES (?, 'completed', 'openai-compatible', 'm', 0)`,
		sessionID,
	)
	if err != nil {
		h.t.Fatalf("seed turn: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) seedEvent() int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, created_at, updated_at) VALUES (0, 'manual', 'e', 0, 0)`,
	)
	if err != nil {
		h.t.Fatalf("seed event: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) exec(query string, args ...any) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(query, args...); err != nil {
		h.t.Fatalf("exec %q: %v", query, err)
	}
}

func joinIDs(ids []int64) string {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, strconv.FormatInt(id, 10))
	}
	return strings.Join(parts, ",")
}
