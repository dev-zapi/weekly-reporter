package tools

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

// 用例逐条对照 e2e/report-list-tool.spec.ts 的断言集（票 #108「工具行为以
// e2e/report-list-tool.spec.ts 的断言集为对等基准」）。

func TestQueryReportListDefaultsToSameAudienceAdoptedCurrentFinals(t *testing.T) {
	f := newFixture(t, "personal")

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID, mustParseListInput(t, `{}`))
	if !result.OK {
		t.Fatalf("expected ok, got %#v", result.Error)
	}

	decoded := decodeJSON(t, result)
	// e2e: appliedFilters 全等
	if !reflect.DeepEqual(decoded["appliedFilters"], map[string]any{
		"query":              nil,
		"title":              nil,
		"startDate":          nil,
		"endDate":            nil,
		"statuses":           []any{"current"},
		"includeLegacy":      false,
		"relation":           "overlap",
		"relativeToReportId": nil,
		"cursor":             nil,
		"limit":              float64(10),
	}) {
		t.Fatalf("appliedFilters = %#v", decoded["appliedFilters"])
	}

	items := decoded["items"].([]any)
	ids := make([]float64, 0, len(items))
	for _, raw := range items {
		ids = append(ids, raw.(map[string]any)["reportId"].(float64))
	}
	for _, want := range []int64{f.adjacentReportID, f.sameAudienceReportID} {
		found := false
		for _, id := range ids {
			if int64(id) == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("items missing report %d: %v", want, ids)
		}
	}
	for _, unwanted := range []int64{f.crossAudienceReportID, f.currentLegacyReportID, f.staleReportID} {
		for _, id := range ids {
			if int64(id) == unwanted {
				t.Fatalf("items unexpectedly contain %d: %v", unwanted, ids)
			}
		}
	}

	// e2e: 每项的键集恰好 9 个（无 warning / matches）
	for _, raw := range items {
		item := raw.(map[string]any)
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		want := []string{
			"audience", "contentAvailable", "finalStatus", "isLegacy",
			"reportId", "title", "updatedAt", "weekEnd", "weekStart",
		}
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("item keys = %v, want %v", keys, want)
		}
		if item["audience"] != "personal" || item["finalStatus"] != "current" || item["isLegacy"] != false {
			t.Fatalf("unexpected item shape: %#v", item)
		}
		if item["updatedAt"] != isoSeconds(fixtureUnix) {
			t.Fatalf("updatedAt = %v", item["updatedAt"])
		}
	}

	// e2e: 出参不得泄露原稿 / 建议 / 评分
	payload, _ := json.Marshal(result)
	for _, forbidden := range []string{"sourceDraft", "suggestions", "scoreOverall", "raw source"} {
		if containsBytes(payload, forbidden) {
			t.Fatalf("output leaks %q: %s", forbidden, payload)
		}
	}
	if decoded["hasMore"] != false || decoded["nextCursor"] != nil {
		t.Fatalf("hasMore/nextCursor = %v/%v", decoded["hasMore"], decoded["nextCursor"])
	}
}

func containsBytes(haystack []byte, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) && stringContains(string(haystack), needle)
}

func stringContains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestQueryReportListExplicitStaleAndLegacyWarnings(t *testing.T) {
	f := newFixture(t, "personal")

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"statuses":["current","stale"],"includeLegacy":true}`))
	if !result.OK {
		t.Fatalf("expected ok, got %#v", result.Error)
	}
	decoded := decodeJSON(t, result)
	filters := decoded["appliedFilters"].(map[string]any)
	if !reflect.DeepEqual(filters["statuses"], []any{"current", "stale"}) || filters["includeLegacy"] != true {
		t.Fatalf("appliedFilters = %#v", filters)
	}

	byID := map[int64]map[string]any{}
	for _, raw := range decoded["items"].([]any) {
		item := raw.(map[string]any)
		byID[int64(item["reportId"].(float64))] = item
	}
	stale, ok := byID[f.staleReportID]
	if !ok || stale["finalStatus"] != "stale" {
		t.Fatalf("stale item = %#v", stale)
	}
	if warning, _ := stale["warning"].(string); warning != StaleFinalWarning {
		t.Fatalf("stale warning = %q", warning)
	}
	legacy, ok := byID[f.legacyReportID]
	if !ok || legacy["isLegacy"] != true {
		t.Fatalf("legacy item = %#v", legacy)
	}
	if warning, _ := legacy["warning"].(string); warning != LegacyReportWarning {
		t.Fatalf("legacy warning = %q", warning)
	}

	// e2e: 领导版正文不得出现在个人版列表输出
	payload, _ := json.Marshal(result)
	if containsBytes(payload, "leadership secret") {
		t.Fatalf("output leaks leadership content: %s", payload)
	}
}

func TestQueryReportListRejectsLegacyForLeadership(t *testing.T) {
	f := newFixture(t, "leadership")

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"includeLegacy":true}`))
	if result.OK || result.Error.Code != ErrorCodeNotAvailable {
		t.Fatalf("expected NOT_AVAILABLE, got %#v", result.Error)
	}
	if result.Error.Message != "legacy report history is available only to personal generation sessions" {
		t.Fatalf("message = %q", result.Error.Message)
	}
}

func TestQueryReportListPreviousAdjacentIsExactAndNotPaged(t *testing.T) {
	f := newFixture(t, "personal")

	// e2e 同时送 query/startDate/endDate/cursor/limit，全部应被忽略并规范化。
	input := mustParseListInput(t, `{"relation":"previous_adjacent","relativeToReportId":`+
		itoa(f.targetReportID)+`,"query":"ignored query","startDate":"1900-01-01","endDate":"1900-01-02","cursor":"ignored cursor","limit":20}`)
	result := QueryReportListForSession(t.Context(), f.q, f.sessionID, input)
	if !result.OK {
		t.Fatalf("expected ok, got %#v", result.Error)
	}
	decoded := decodeJSON(t, result)
	items := decoded["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item := items[0].(map[string]any)
	if int64(item["reportId"].(float64)) != f.adjacentReportID {
		t.Fatalf("item = %#v", item)
	}
	filters := decoded["appliedFilters"].(map[string]any)
	if filters["query"] != nil || filters["startDate"] != nil || filters["endDate"] != nil ||
		filters["relation"] != "previous_adjacent" || filters["cursor"] != nil ||
		filters["limit"] != float64(1) ||
		int64(filters["relativeToReportId"].(float64)) != f.targetReportID {
		t.Fatalf("appliedFilters = %#v", filters)
	}
	if decoded["hasMore"] != false || decoded["nextCursor"] != nil {
		t.Fatalf("hasMore/nextCursor = %v/%v", decoded["hasMore"], decoded["nextCursor"])
	}
}

func TestQueryReportListPreviousAdjacentWithoutSourceIsEmptySuccess(t *testing.T) {
	f := newFixture(t, "personal")
	// 把上一周期的周报删掉（模拟 e2e 的 no-adjacent 模式）。
	if _, err := f.sql.ExecContext(t.Context(), `DELETE FROM report_variants WHERE report_id = ?`, f.adjacentReportID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sql.ExecContext(t.Context(), `DELETE FROM reports WHERE id = ?`, f.adjacentReportID); err != nil {
		t.Fatal(err)
	}

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"relation":"previous_adjacent","relativeToReportId":`+itoa(f.targetReportID)+`}`))
	decoded := decodeJSON(t, result)
	if decoded["ok"] != true {
		t.Fatalf("decoded = %#v", decoded)
	}
	if items := decoded["items"].([]any); len(items) != 0 {
		t.Fatalf("items = %#v", items)
	}
	if decoded["nextCursor"] != nil || decoded["hasMore"] != false {
		t.Fatalf("nextCursor/hasMore = %v/%v", decoded["nextCursor"], decoded["hasMore"])
	}
}

func TestQueryReportListQueryAndTitleMatchWithNormalizedFilters(t *testing.T) {
	f := newFixture(t, "personal")

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID, mustParseListInput(t,
		`{"query":"searchable","title":"personal history","startDate":"2026-12-01","endDate":"2027-01-31","statuses":["current"],"includeLegacy":false,"relation":"overlap","limit":20}`))
	if !result.OK {
		t.Fatalf("expected ok, got %#v", result.Error)
	}
	decoded := decodeJSON(t, result)
	filters := decoded["appliedFilters"].(map[string]any)
	if filters["query"] != "searchable" || filters["title"] != "personal history" ||
		filters["startDate"] != "2026-12-01" || filters["endDate"] != "2027-01-31" ||
		filters["limit"] != float64(20) {
		t.Fatalf("appliedFilters = %#v", filters)
	}
	items := decoded["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item := items[0].(map[string]any)
	if int64(item["reportId"].(float64)) != f.sameAudienceReportID {
		t.Fatalf("item = %#v", item)
	}
	matches, ok := item["matches"].([]any)
	if !ok || len(matches) == 0 {
		t.Fatalf("matches = %#v", item["matches"])
	}
	first := matches[0].(map[string]any)
	if first["field"] != "content" || first["content"] != "# searchable personal final" {
		t.Fatalf("match = %#v", first)
	}
	// 没有 query 时不出 matchesTruncated；有 query 时必须出现（e2e 依赖该键）。
	if decoded["matchesTruncated"] != false {
		t.Fatalf("matchesTruncated = %v", decoded["matchesTruncated"])
	}
}

func TestQueryReportListQueryMatchesTitleAndContent(t *testing.T) {
	f := newFixture(t, "personal")

	// title 命中先于正文命中；同一项可能两者都有。
	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"query":"previous adjacent"}`))
	decoded := decodeJSON(t, result)
	items := decoded["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	matches := items[0].(map[string]any)["matches"].([]any)
	if len(matches) < 2 {
		t.Fatalf("matches = %#v", matches)
	}
	if matches[0].(map[string]any)["field"] != "title" {
		t.Fatalf("first match = %#v", matches[0])
	}
}

func TestQueryReportListStrictInputRejectsUnknownAudience(t *testing.T) {
	// e2e: audience 参数被拒绝（zod strictObject → AI SDK InvalidToolInputError →
	// INVALID_QUERY），且不会改变服务端固定受众。
	if _, err := ParseReportListInput([]byte(`{"audience":"leadership"}`)); err == nil {
		t.Fatal("expected strict parse to reject the audience key")
	}
}

func TestQueryReportListInvalidInputs(t *testing.T) {
	f := newFixture(t, "personal")
	cases := []struct {
		name    string
		input   string
		message string
	}{
		{"relation", `{"relation":"siblings"}`, "relation must be overlap or previous_adjacent"},
		{"empty statuses", `{"statuses":[]}`, "statuses must contain current or stale"},
		{"bad status", `{"statuses":["current","archived"]}`, "statuses must contain current or stale"},
		{"date shape", `{"startDate":"2027/01/01"}`, "startDate must use YYYY-MM-DD"},
		{"date invalid", `{"startDate":"2027-02-31"}`, "startDate must be a valid date"},
		{"date order", `{"startDate":"2027-02-02","endDate":"2027-02-01"}`, "startDate must not be after endDate"},
		{"limit zero", `{"limit":0}`, "limit must be an integer from 1 to 20"},
		{"limit fraction", `{"limit":1.5}`, "limit must be an integer from 1 to 20"},
		{"limit high", `{"limit":21}`, "limit must be an integer from 1 to 20"},
		{"cursor", `{"cursor":"ignored cursor"}`, "cursor is invalid"},
		{"title long", `{"title":"` + repeat("x", 201) + `"}`, "title must contain 1 to 200 characters after trimming"},
		{"query blank", `{"query":"   "}`, "query must contain 1 to 200 characters after trimming"},
		{"previous adjacent id", `{"relation":"previous_adjacent","relativeToReportId":999}`, "previous_adjacent requires relativeToReportId to be the current session report"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := mustParseListInput(t, tc.input)
			result := QueryReportListForSession(t.Context(), f.q, f.sessionID, input)
			if result.OK || result.Error.Code != ErrorCodeInvalidQuery {
				t.Fatalf("expected INVALID_QUERY, got %#v", result)
			}
			if result.Error.Message != tc.message {
				t.Fatalf("message = %q, want %q", result.Error.Message, tc.message)
			}
		})
	}
}

func TestQueryReportListMissingSessionAndReport(t *testing.T) {
	f := newFixture(t, "personal")

	result := QueryReportListForSession(t.Context(), f.q, 999_999, mustParseListInput(t, `{}`))
	if result.OK || result.Error.Code != ErrorCodeQueryFailed ||
		result.Error.Message != "Generation session is unavailable" {
		t.Fatalf("missing session: %#v", result)
	}

	result = QueryReportListForSession(t.Context(), f.q, f.sessionID, mustParseListInput(t, `{}`))
	if !result.OK {
		t.Fatalf("baseline: %#v", result)
	}
	if _, err := f.sql.ExecContext(t.Context(), `DELETE FROM reports WHERE id = ?`, f.targetReportID); err != nil {
		t.Fatal(err)
	}
	result = QueryReportListForSession(t.Context(), f.q, f.sessionID, mustParseListInput(t, `{}`))
	if result.OK || result.Error.Message != "Current session report is unavailable" {
		t.Fatalf("missing report: %#v", result)
	}
}

func TestQueryReportListCursorPagination(t *testing.T) {
	f := newFixture(t, "personal")

	first := QueryReportListForSession(t.Context(), f.q, f.sessionID, mustParseListInput(t, `{"limit":1}`))
	decoded := decodeJSON(t, first)
	if decoded["hasMore"] != true {
		t.Fatalf("expected hasMore, got %#v", decoded)
	}
	nextCursor, ok := decoded["nextCursor"].(string)
	if !ok || nextCursor == "" {
		t.Fatalf("nextCursor = %#v", decoded["nextCursor"])
	}
	firstItem := decoded["items"].([]any)[0].(map[string]any)

	second := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"limit":1,"cursor":`+quote(nextCursor)+`}`))
	secondDecoded := decodeJSON(t, second)
	secondItems := secondDecoded["items"].([]any)
	if len(secondItems) != 1 {
		t.Fatalf("second page = %#v", secondDecoded)
	}
	if secondItems[0].(map[string]any)["reportId"] == firstItem["reportId"] {
		t.Fatalf("second page repeats the first item: %#v", secondItems[0])
	}
	filters := secondDecoded["appliedFilters"].(map[string]any)
	if filters["cursor"] != nextCursor {
		t.Fatalf("appliedFilters.cursor = %#v", filters["cursor"])
	}
}

func TestQueryReportListLegacyRowsExcludeModernAndBlankContent(t *testing.T) {
	f := newFixture(t, "personal")
	blankLegacyID := f.insertReport("blank legacy", "2026-10-05", "2026-10-11", "   \n\t ")

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"includeLegacy":true,"limit":20}`))
	ids := map[int64]bool{}
	for _, raw := range decodeJSON(t, result)["items"].([]any) {
		ids[int64(raw.(map[string]any)["reportId"].(float64))] = true
	}
	if !ids[f.legacyReportID] {
		t.Fatalf("legacy report missing: %v", ids)
	}
	if ids[blankLegacyID] {
		t.Fatalf("blank legacy report must be excluded: %v", ids)
	}
	// 有 report_variants 的现代周报不再走 legacy 路径（即使 current 未采用）。
	if ids[f.currentLegacyReportID] || ids[f.unacceptedReportID] || ids[f.noneReportID] {
		t.Fatalf("modern reports leaked into legacy list: %v", ids)
	}
}

func TestQueryReportListMatchBudgetTruncatesLaterItems(t *testing.T) {
	f := newFixture(t, "personal")
	// 两项各带 12,000 字符的命中正文：第一项吃满 20,000 预算，第二项空 matches。
	accepted := int64(1)
	for _, week := range []struct{ start, end string }{{"2026-10-19", "2026-10-25"}, {"2026-10-12", "2026-10-18"}} {
		content := "budget needle " + repeat("y", 12_000)
		id := f.insertReport("budget "+week.start, week.start, week.end, "# raw source")
		f.insertVariant(id, "personal", "current", &content, &accepted)
	}

	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"query":"needle","limit":20}`))
	decoded := decodeJSON(t, result)
	if decoded["matchesTruncated"] != true {
		t.Fatalf("matchesTruncated = %#v", decoded["matchesTruncated"])
	}
	items := decoded["items"].([]any)
	if len(items) < 2 {
		t.Fatalf("items = %d", len(items))
	}
	lastMatches := items[len(items)-1].(map[string]any)["matches"].([]any)
	if len(lastMatches) != 0 {
		t.Fatalf("last item should have no matches after truncation: %#v", lastMatches)
	}
}

func TestQueryReportListCursorEncodeDecodeIsByteCompatible(t *testing.T) {
	// Node 的 base64url(JSON.stringify({version,weekEnd,reportId})) 逐字节形状。
	encoded := encodeCursor("2027-01-10", 42)
	want := "eyJ2ZXJzaW9uIjoxLCJ3ZWVrRW5kIjoiMjAyNy0wMS0xMCIsInJlcG9ydElkIjo0Mn0"
	if encoded != want {
		t.Fatalf("encodeCursor = %q, want %q", encoded, want)
	}
	parsed := parseCursor(encoded)
	if parsed == nil || parsed.WeekEnd != "2027-01-10" || parsed.ReportID != 42 {
		t.Fatalf("parseCursor = %#v", parsed)
	}
	// Node 的 base64url 解码是宽松的：非法字符被忽略、padding 可选。
	for _, variant := range []string{want + "==", want[:5] + "@" + want[5:], " " + want + "\n"} {
		if parseCursor(variant) == nil {
			t.Fatalf("lenient decode failed for %q", variant)
		}
	}
	// 形状校验：version 不是 1 / reportId 非正整数 / weekEnd 非日期都拒绝。
	for _, raw := range []string{
		`{"version":2,"weekEnd":"2027-01-10","reportId":1}`,
		`{"version":1,"weekEnd":"2027-01-10","reportId":0}`,
		`{"version":1,"weekEnd":"2027-01-10","reportId":1.5}`,
		`{"version":1,"weekEnd":"2027-13-10","reportId":1}`,
		`{"version":1,"weekEnd":20270110,"reportId":1}`,
	} {
		if parseCursor(encodeRawBase64URL(raw)) != nil {
			t.Fatalf("expected invalid cursor for %s", raw)
		}
	}
}

func encodeRawBase64URL(value string) string {
	return base64URLEncode([]byte(value))
}

func TestQueryReportListItemWarningOnlyForStaleAndLegacy(t *testing.T) {
	f := newFixture(t, "personal")
	result := QueryReportListForSession(t.Context(), f.q, f.sessionID,
		mustParseListInput(t, `{"statuses":["current","stale"]}`))
	for _, raw := range decodeJSON(t, result)["items"].([]any) {
		item := raw.(map[string]any)
		_, hasWarning := item["warning"]
		wantWarning := item["finalStatus"] == "stale" || item["isLegacy"] == true
		if hasWarning != wantWarning {
			t.Fatalf("warning presence mismatch: %#v", item)
		}
		_, hasMatches := item["matches"]
		if hasMatches {
			t.Fatalf("matches must be absent without query: %#v", item)
		}
	}
}

func itoa(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
