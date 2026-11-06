package tools

import (
	"encoding/json"
	"reflect"
	"testing"
	"unicode/utf8"
)

// 用例逐条对照 e2e/report-list-tool.spec.ts 的「AI 查询周报内容」断言集，并补上
// src/lib/generation/report-content-tool.test.ts 里的两个用例（convert 票要求）。

func TestQueryReportContentReturnsCurrentVariantWithoutAcceptedProposal(t *testing.T) {
	// 对应 report-content-tool.test.ts 用例 1：没有 acceptedProposalId 的 current
	// 变体仍可读（正文工具不要求提案采用）。
	f := newFixture(t, "leadership")

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(f.adjacentReportID)+`}`))
	if !result.OK || !result.Found {
		t.Fatalf("expected found, got %#v", result)
	}
	decoded := decodeJSON(t, result)
	if decoded["content"] != "# previous adjacent leadership final" {
		t.Fatalf("content = %v", decoded["content"])
	}
	identity := decoded["identity"].(map[string]any)
	if identity["finalStatus"] != "current" || identity["audience"] != "leadership" ||
		identity["isLegacy"] != false || identity["updatedAt"] != isoSeconds(fixtureUnix) {
		t.Fatalf("identity = %#v", identity)
	}
	if identity["historicalReference"] != HistoricalReferenceLabel {
		t.Fatalf("historicalReference = %v", identity["historicalReference"])
	}
	if _, ok := identity["warning"]; ok {
		t.Fatalf("current final must not carry a warning: %#v", identity)
	}
	if decoded["truncated"] != false || decoded["totalChars"] != float64(len("# previous adjacent leadership final")) ||
		decoded["returnedChars"] != decoded["totalChars"] {
		t.Fatalf("truncation fields = %#v", decoded)
	}
}

func TestQueryReportContentRejectsFinalStatusNone(t *testing.T) {
	// 对应 report-content-tool.test.ts 用例 2：finalStatus=none 的变体不可读，
	// 领导版回 NOT_AVAILABLE。
	f := newFixture(t, "leadership")

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(f.noneReportID)+`}`))
	if result.OK || result.Error.Code != ErrorCodeNotAvailable {
		t.Fatalf("expected NOT_AVAILABLE, got %#v", result)
	}
	if result.Error.Message != "The requested report has no current final for this audience" {
		t.Fatalf("message = %q", result.Error.Message)
	}
}

func TestQueryReportContentLeadershipAuthorizationMatrix(t *testing.T) {
	f := newFixture(t, "leadership")

	// e2e：领导版对 stale / legacy / none / 未采用预览 / 跨受众内容一律 NOT_AVAILABLE。
	cases := []string{
		`{"reportId":` + itoa(f.staleReportID) + `}`,
		`{"reportId":` + itoa(f.legacyReportID) + `,"allowLegacy":true}`,
		`{"reportId":` + itoa(f.noneReportID) + `,"allowStale":true}`,
		`{"reportId":` + itoa(f.unacceptedReportID) + `,"allowStale":true}`,
		`{"reportId":` + itoa(f.sameAudienceReportID) + `,"allowLegacy":true}`,
	}
	for _, raw := range cases {
		result := QueryReportContentForSession(t.Context(), f.q, f.sessionID, mustParseContentInput(t, raw))
		if result.OK || result.Error.Code != ErrorCodeNotAvailable {
			t.Fatalf("%s: expected NOT_AVAILABLE, got %#v", raw, result)
		}
		payload, _ := json.Marshal(result)
		if containsBytes(payload, "secret") {
			t.Fatalf("%s leaks content: %s", raw, payload)
		}
	}
}

func TestQueryReportContentStaleAndLegacyAuthorizations(t *testing.T) {
	f := newFixture(t, "personal")
	cases := []struct {
		name       string
		input      string
		found      bool
		status     string
		isLegacy   bool
		warning    string
		contentHas string
	}{
		{"stale denied", `{"reportId":` + itoa(f.staleReportID) + `}`, false, "", false, "", ""},
		{"stale allowed", `{"reportId":` + itoa(f.staleReportID) + `,"allowStale":true}`, true, "stale", false, StaleFinalWarning, "# personal stale secret"},
		{"legacy denied", `{"reportId":` + itoa(f.legacyReportID) + `}`, false, "", false, "", ""},
		{"legacy allowed", `{"reportId":` + itoa(f.legacyReportID) + `,"allowLegacy":true}`, true, "current", true, LegacyReportWarning, "# legacy readable content"},
		{"cross audience", `{"reportId":` + itoa(f.crossAudienceReportID) + `,"allowLegacy":true}`, false, "", false, "", ""},
		{"missing report", `{"reportId":999999999,"query":"missing"}`, false, "", false, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := QueryReportContentForSession(t.Context(), f.q, f.sessionID, mustParseContentInput(t, tc.input))
			decoded := decodeJSON(t, result)
			if decoded["ok"] != true || decoded["found"] != tc.found {
				t.Fatalf("decoded = %#v", decoded)
			}
			if !tc.found {
				if decoded["truncated"] != false {
					t.Fatalf("not-found shape = %#v", decoded)
				}
				// 未找到时回传入参里的 reportId（e2e 断言 reportId 原样回显）。
				if _, ok := decoded["reportId"]; !ok {
					t.Fatalf("not-found must echo reportId: %#v", decoded)
				}
				return
			}
			identity := decoded["identity"].(map[string]any)
			if identity["finalStatus"] != tc.status || identity["isLegacy"] != tc.isLegacy {
				t.Fatalf("identity = %#v", identity)
			}
			if tc.warning != "" {
				if identity["warning"] != tc.warning {
					t.Fatalf("warning = %v", identity["warning"])
				}
			} else if _, ok := identity["warning"]; ok {
				t.Fatalf("unexpected warning: %#v", identity)
			}
			content, _ := decoded["content"].(string)
			if !containsBytes([]byte(content), tc.contentHas) {
				t.Fatalf("content = %q", content)
			}
		})
	}
}

func TestQueryReportContentGrepReturnsContextBoundedMatches(t *testing.T) {
	f := newFixture(t, "personal")

	// e2e：query=searchable, maxMatches=5, contextLines=1 → 1 个命中段、1 行命中。
	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(f.sameAudienceReportID)+`,"query":"searchable","maxMatches":5,"contextLines":1}`))
	if !result.OK || !result.Found {
		t.Fatalf("expected found, got %#v", result)
	}
	decoded := decodeJSON(t, result)
	if decoded["query"] != "searchable" || decoded["totalMatches"] != float64(1) ||
		decoded["returnedMatches"] != float64(1) || decoded["truncated"] != false {
		t.Fatalf("decoded = %#v", decoded)
	}
	matches := decoded["matches"].([]any)
	if len(matches) != 1 {
		t.Fatalf("matches = %#v", matches)
	}
	match := matches[0].(map[string]any)
	if match["startLine"] != float64(1) || match["endLine"] != float64(1) ||
		match["content"] != "# searchable personal final" {
		t.Fatalf("match = %#v", match)
	}
	payload, _ := json.Marshal(result)
	if !containsBytes(payload, HistoricalReferenceLabel) {
		t.Fatalf("output missing the historical reference label: %s", payload)
	}
}

func TestQueryReportContentGrepHonoursContextLinesAndMergesRanges(t *testing.T) {
	f := newFixture(t, "personal")
	content := "line one\nline two needle\nline three\nline four\nline five needle\nline six"
	id := f.insertReport("grep ranges", "2026-09-28", "2026-10-04", "# raw")
	accepted := int64(7)
	f.insertVariant(id, "personal", "current", &content, &accepted)

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(id)+`,"query":"needle","contextLines":0,"maxMatches":10}`))
	decoded := decodeJSON(t, result)
	matches := decoded["matches"].([]any)
	if len(matches) != 2 {
		t.Fatalf("expected two separate ranges, got %#v", matches)
	}
	if decoded["totalMatches"] != float64(2) || decoded["returnedMatches"] != float64(2) {
		t.Fatalf("counts = %#v", decoded)
	}
	first := matches[0].(map[string]any)
	if first["startLine"] != float64(2) || first["endLine"] != float64(2) || first["content"] != "line two needle" {
		t.Fatalf("first = %#v", first)
	}

	// contextLines=1 把两段扩成相邻并合并成一段（行 1..6）。
	merged := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(id)+`,"query":"needle","contextLines":1,"maxMatches":10}`))
	mergedMatches := decodeJSON(t, merged)["matches"].([]any)
	if len(mergedMatches) != 1 {
		t.Fatalf("expected merged range, got %#v", mergedMatches)
	}
	range0 := mergedMatches[0].(map[string]any)
	if range0["startLine"] != float64(1) || range0["endLine"] != float64(6) {
		t.Fatalf("merged range = %#v", range0)
	}
}

func TestQueryReportContentTruncatesLongBody(t *testing.T) {
	f := newFixture(t, "personal")

	// e2e：长正文 totalChars > 40,000，returnedChars <= 40,000，truncated=true。
	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(f.longReportID)+`}`))
	decoded := decodeJSON(t, result)
	if decoded["truncated"] != true {
		t.Fatalf("decoded = %#v", decoded)
	}
	totalChars := int(decoded["totalChars"].(float64))
	returnedChars := int(decoded["returnedChars"].(float64))
	if totalChars <= 40_000 || returnedChars > 40_000 {
		t.Fatalf("total=%d returned=%d", totalChars, returnedChars)
	}
	content := decoded["content"].(string)
	if !containsBytes([]byte(content), truncationMarker) {
		t.Fatalf("content missing truncation marker")
	}
	if returnedChars != len([]rune(content)) {
		// ASCII 夹具下 UTF-16 单元数 == 字符数。
		t.Fatalf("returnedChars = %d, content runes = %d", returnedChars, len([]rune(content)))
	}
}

func TestQueryReportContentMatchBudgetDropsOversizedRanges(t *testing.T) {
	f := newFixture(t, "personal")
	// 两段各 30,000 字符的命中：第一段入结果、第二段超预算被丢（不是清零预算
	// 后继续，与列表工具的语义不同）。
	content := "needle " + repeat("a", 30_000) + "\nseparator\nneedle " + repeat("b", 30_000)
	id := f.insertReport("budget content", "2026-09-21", "2026-09-27", "# raw")
	accepted := int64(9)
	f.insertVariant(id, "personal", "current", &content, &accepted)

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(id)+`,"query":"needle","contextLines":0,"maxMatches":10}`))
	decoded := decodeJSON(t, result)
	if decoded["totalMatches"] != float64(2) || decoded["returnedMatches"] != float64(1) {
		t.Fatalf("decoded = %#v", decoded)
	}
	if decoded["truncated"] != true {
		t.Fatalf("expected truncated, got %#v", decoded["truncated"])
	}
}

func TestQueryReportContentTotalMatchesBeyondMaxMatchesTruncates(t *testing.T) {
	f := newFixture(t, "personal")
	content := "needle one\nx\nneedle two\nx\nneedle three"
	id := f.insertReport("many matches", "2026-09-14", "2026-09-20", "# raw")
	accepted := int64(11)
	f.insertVariant(id, "personal", "current", &content, &accepted)

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(id)+`,"query":"needle","contextLines":0,"maxMatches":2}`))
	decoded := decodeJSON(t, result)
	if decoded["totalMatches"] != float64(3) || decoded["returnedMatches"] != float64(2) ||
		decoded["truncated"] != true {
		t.Fatalf("decoded = %#v", decoded)
	}
}

func TestQueryReportContentEmptyResultIsSuccess(t *testing.T) {
	f := newFixture(t, "personal")

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":999999999,"query":"missing"}`))
	decoded := decodeJSON(t, result)
	if !reflect.DeepEqual(decoded, map[string]any{
		"ok":                true,
		"found":             false,
		"reportId":          float64(999999999),
		"truncated":         false,
		"referenceBoundary": map[string]any{"label": HistoricalReferenceLabel, "statement": ReportContentReferenceBoundary.Statement},
	}) {
		t.Fatalf("decoded = %#v", decoded)
	}
}

func TestQueryReportContentInvalidInputs(t *testing.T) {
	f := newFixture(t, "personal")
	cases := []struct {
		name    string
		input   string
		message string
	}{
		{"missing reportId", `{}`, "reportId must be a positive integer"},
		{"zero reportId", `{"reportId":0}`, "reportId must be a positive integer"},
		{"negative reportId", `{"reportId":-3}`, "reportId must be a positive integer"},
		{"fractional reportId", `{"reportId":1.5}`, "reportId must be a positive integer"},
		{"blank query", `{"reportId":1,"query":"   "}`, "query must contain 1 to 200 characters after trimming"},
		{"long query", `{"reportId":1,"query":"` + repeat("x", 201) + `"}`, "query must contain 1 to 200 characters after trimming"},
		{"maxMatches low", `{"reportId":1,"maxMatches":0}`, "maxMatches must be an integer from 1 to 10"},
		{"maxMatches high", `{"reportId":1,"maxMatches":11}`, "maxMatches must be an integer from 1 to 10"},
		{"maxMatches fractional", `{"reportId":1,"maxMatches":2.5}`, "maxMatches must be an integer from 1 to 10"},
		{"contextLines negative", `{"reportId":1,"contextLines":-1}`, "contextLines must be an integer from 0 to 5"},
		{"contextLines high", `{"reportId":1,"contextLines":6}`, "contextLines must be an integer from 0 to 5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := QueryReportContentForSession(t.Context(), f.q, f.sessionID, mustParseContentInput(t, tc.input))
			if result.OK || result.Error.Code != ErrorCodeInvalidQuery {
				t.Fatalf("expected INVALID_QUERY, got %#v", result)
			}
			if result.Error.Message != tc.message {
				t.Fatalf("message = %q, want %q", result.Error.Message, tc.message)
			}
		})
	}
}

func TestQueryReportContentStrictInputRejectsUnknownKeys(t *testing.T) {
	for _, raw := range []string{
		`{"reportId":1,"audience":"leadership"}`,
		`{"reportId":1,"query":null}`,
		`{"reportId":"1"}`,
	} {
		if _, err := ParseReportContentInput([]byte(raw)); err == nil {
			t.Fatalf("expected strict parse failure for %s", raw)
		}
	}
}

func TestQueryReportContentMissingSessionIsQueryFailed(t *testing.T) {
	f := newFixture(t, "personal")
	result := QueryReportContentForSession(t.Context(), f.q, 999_999,
		mustParseContentInput(t, `{"reportId":1}`))
	if result.OK || result.Error.Code != ErrorCodeQueryFailed ||
		result.Error.Message != "Generation session is unavailable" {
		t.Fatalf("result = %#v", result)
	}
}

func TestQueryReportContentSliceUTF16NeverSplitsSurrogatePairs(t *testing.T) {
	// CJK 与增补平面边界：slice 到 2 个单元时保留一个 BMP 字符 + 一个代理对，
	// 结果必须仍是合法 UTF-8（不能出现半个代理项）。
	value := "a" + "😀" + "b" // a(1) + emoji(2) + b(1)
	if got := sliceUTF16(value, 2); got != "a" {
		t.Fatalf("sliceUTF16(2) = %q", got)
	}
	if got := sliceUTF16(value, 3); got != "a😀" {
		t.Fatalf("sliceUTF16(3) = %q", got)
	}
}

func TestQueryReportContentSurrogateTruncationKeepsReturnedCharsConsistent(t *testing.T) {
	// 截断点落在代理对中间：39,977 个 'a' + 😀 时 slice 上限是 39,978，代理对
	// 放不下，必须整对舍弃而不是留半个（Go 的 string 表示不了孤立代理项）。
	content := repeat("a", 39_977) + "😀" + repeat("b", 100)
	f := newFixture(t, "personal")
	id := f.insertReport("surrogate boundary", "2026-09-07", "2026-09-13", "# raw")
	accepted := int64(13)
	f.insertVariant(id, "personal", "current", &content, &accepted)

	result := QueryReportContentForSession(t.Context(), f.q, f.sessionID,
		mustParseContentInput(t, `{"reportId":`+itoa(id)+`}`))
	if result.ReturnedChars == nil || result.Content == nil {
		t.Fatalf("result = %#v", result)
	}
	if *result.ReturnedChars > 40_000 {
		t.Fatalf("returnedChars = %d", *result.ReturnedChars)
	}
	// 39,977 + 标记 22 = 39,999；emoji 整对丢弃。
	if *result.ReturnedChars != 39_999 {
		t.Fatalf("returnedChars = %d, want 39999", *result.ReturnedChars)
	}
	if !utf8.ValidString(*result.Content) {
		t.Fatal("truncated content is not valid UTF-8")
	}
	if !containsBytes([]byte(*result.Content), truncationMarker) {
		t.Fatal("truncated content is missing the marker")
	}
}
