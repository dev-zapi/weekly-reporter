package generation

import (
	"encoding/json"
	"strings"
	"testing"
)

// 本文件是 src/lib/generation/public-summary.test.ts 的 Go 同用例集（ADR-0029）：
// 契约字段显式存在、历史正文不得被复制、截断计数与 stale/legacy 元数据。

func stringSlice(t *testing.T, value any) []string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode string slice: %v", err)
	}
	return out
}

func objectSlice(t *testing.T, value any) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode object slice: %v", err)
	}
	return out
}

func TestBuildPublicGenerationSummaryDropsCopiedHistoricalBody(t *testing.T) {
	const historicalBody = "不得复制的历史计划正文"
	summary := BuildPublicGenerationSummary(
		[]string{"按原稿组织事实。", "引用" + historicalBody + "作为事实。"},
		[]string{"调整本周事实表达。", "变更：" + historicalBody + "。"},
		nil,
		[]map[string]any{decodeObject(t, `{
			"ok": true, "found": true,
			"identity": {"reportId": 7, "title": "上一周期周报", "audience": "personal",
				"weekStart": "2026-08-24", "weekEnd": "2026-08-30", "finalStatus": "current",
				"isLegacy": false, "updatedAt": "2026-08-30T00:00:00.000Z"},
			"content": "不得复制的历史计划正文", "truncated": false
		}`)},
	)

	if summary["version"] != 1 {
		t.Fatalf("version = %v, want 1", summary["version"])
	}
	modelHandling := stringSlice(t, summary["modelHandling"])
	if len(modelHandling) != 1 || modelHandling[0] != "按原稿组织事实。" {
		t.Fatalf("modelHandling = %v", modelHandling)
	}
	references := objectSlice(t, summary["historicalReferences"])
	if len(references) != 1 || references[0]["kind"] != "report-query" || references[0]["trust"] != "historical-reference-untrusted" {
		t.Fatalf("historicalReferences = %v", references)
	}
	if references[0]["reportId"] != float64(7) {
		t.Fatalf("reportId = %v", references[0]["reportId"])
	}
	if failures := objectSlice(t, summary["failureStates"]); len(failures) != 0 {
		t.Fatalf("failureStates = %v, want []", failures)
	}
	if truncations := objectSlice(t, summary["truncationStates"]); len(truncations) != 0 {
		t.Fatalf("truncationStates = %v, want []", truncations)
	}
	statuses := objectSlice(t, summary["toolStatuses"])
	if len(statuses) != 2 ||
		statuses[0]["toolName"] != "query_report_content" || statuses[0]["status"] != "succeeded" || statuses[0]["detail"] != "none" ||
		statuses[1]["toolName"] != "propose_final_report" || statuses[1]["detail"] != "proposal-created" {
		t.Fatalf("toolStatuses = %v", statuses)
	}
	changes := stringSlice(t, summary["changeSummary"])
	if len(changes) != 2 {
		t.Fatalf("changeSummary = %v, want 2 entries", changes)
	}
	if !strings.Contains(changes[0], "历史参考：上一周期周报") {
		t.Fatalf("changeSummary[0] = %q", changes[0])
	}
	if changes[1] != "调整本周事实表达。" {
		t.Fatalf("changeSummary[1] = %q", changes[1])
	}
	factBoundary, _ := summary["factBoundary"].(map[string]any)
	for key, want := range map[string]string{
		"currentWeekFacts": "report-source-draft-only", "historicalReferences": "untrusted",
		"hiddenReasoning": "none", "summaryAsFact": "none", "scoringInput": "none",
	} {
		if factBoundary[key] != want {
			t.Fatalf("factBoundary[%s] = %v, want %s", key, factBoundary[key], want)
		}
	}
}

func TestBuildPublicGenerationSummaryRecordsTruncation(t *testing.T) {
	handling := []string{strings.Repeat("a", 281)}
	for index := 1; index <= 8; index++ {
		handling = append(handling, "handling-"+itoa(index))
	}
	changes := []string{strings.Repeat("b", 281)}
	for index := 1; index <= 12; index++ {
		changes = append(changes, "change-"+itoa(index))
	}
	summary := BuildPublicGenerationSummary(handling, changes, nil, nil)

	if got := stringSlice(t, summary["modelHandling"]); len(got) != 8 || len(got[0]) != 280 {
		t.Fatalf("modelHandling bounds violated: len=%d first=%d", len(got), len(got[0]))
	}
	if got := stringSlice(t, summary["changeSummary"]); len(got) != 12 || len(got[0]) != 280 {
		t.Fatalf("changeSummary bounds violated: len=%d first=%d", len(got), len(got[0]))
	}
	truncations := objectSlice(t, summary["truncationStates"])
	seen := map[string]float64{}
	for _, state := range truncations {
		scope, _ := state["scope"].(string)
		count, _ := state["omittedCount"].(float64)
		seen[scope] = count
	}
	if seen["model-handling"] != 2 || seen["proposal-change-summary"] != 2 {
		t.Fatalf("truncationStates = %v", truncations)
	}
}

func TestBuildPublicGenerationSummaryRecordsStaleAndLegacy(t *testing.T) {
	changes := []string{"Reused stale secret body"}
	for index := 1; index <= 12; index++ {
		changes = append(changes, "provider change "+itoa(index))
	}
	summary := BuildPublicGenerationSummary(
		[]string{"used legacy secret body"},
		changes,
		nil,
		[]map[string]any{
			decodeObject(t, `{
				"ok": true, "found": true,
				"identity": {"reportId": 9, "title": "过期终版", "audience": "personal",
					"weekStart": "2026-08-10", "weekEnd": "2026-08-16", "finalStatus": "stale",
					"isLegacy": false, "updatedAt": "2026-08-17T00:00:00.000Z",
					"warning": "过期终版尚未反映最新周报原稿。"},
				"content": "stale secret body", "truncated": false
			}`),
			decodeObject(t, `{
				"ok": true, "found": true,
				"identity": {"reportId": 10, "title": "旧版周报", "audience": "personal",
					"weekStart": "2026-08-03", "weekEnd": "2026-08-09", "finalStatus": "current",
					"isLegacy": true, "updatedAt": "2026-08-10T00:00:00.000Z",
					"warning": "旧版周报没有周报原稿和受众生成记录，仅供个人版历史参考。"},
				"content": "legacy secret body", "truncated": false
			}`),
		},
	)

	references := objectSlice(t, summary["historicalReferences"])
	if len(references) != 2 {
		t.Fatalf("historicalReferences = %v", references)
	}
	if references[0]["finalStatus"] != "stale" || !strings.Contains(references[0]["warning"].(string), "过期") {
		t.Fatalf("stale reference = %v", references[0])
	}
	if references[1]["isLegacy"] != true || !strings.Contains(references[1]["warning"].(string), "没有周报原稿和受众生成记录") {
		t.Fatalf("legacy reference = %v", references[1])
	}
	changeSummary := stringSlice(t, summary["changeSummary"])
	if len(changeSummary) != 12 {
		t.Fatalf("changeSummary length = %d, want 12", len(changeSummary))
	}
	joined := strings.Join(changeSummary, "\n")
	for _, want := range []string{
		"过期终版 · 2026-08-10–2026-08-16 · personal · stale",
		"旧版周报 · 2026-08-03–2026-08-09 · personal · legacy",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("changeSummary missing %q: %v", want, changeSummary)
		}
	}
	raw, _ := json.Marshal(summary)
	if strings.Contains(string(raw), "stale secret body") || strings.Contains(string(raw), "legacy secret body") {
		t.Fatalf("summary leaked a historical body: %s", raw)
	}
}

func TestBuildPublicGenerationSummaryInitializesEmptyLists(t *testing.T) {
	summary := BuildPublicGenerationSummary(nil, []string{"保留"}, nil, nil)
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"modelHandling", "historicalReferences", "failureStates", "truncationStates", "changeSummary"} {
		if strings.Contains(string(raw), `"`+field+`":null`) {
			t.Fatalf("%s serialized as null (front-end drops the summary): %s", field, raw)
		}
	}
}
