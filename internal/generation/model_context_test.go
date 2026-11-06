package generation

import (
	"encoding/json"
	"strings"
	"testing"
)

// 本文件是 src/lib/generation/context.test.ts 的 Go 同用例集（ADR-0029）：
// 系统上下文必须逐字保留完整原稿、模板、上一版候选与历史参考边界。

func TestBuildModelSystemContextKeepsCompleteSourceAndTemplate(t *testing.T) {
	latest := "# 上一版"
	context := BuildModelSystemContext(ModelSystemContextInput{
		SystemPrompt:          "SYSTEM",
		StylePrompt:           "STYLE",
		ToolRules:             "TOOL",
		Variant:               "personal",
		WeekStart:             "2026-08-10",
		WeekEnd:               "2026-08-16",
		TemplateName:          "模板",
		TemplateContent:       "# 本周成果",
		SourceDraft:           "- 完整事实 A\n- 完整事实 B",
		LatestProposalContent: &latest,
	})

	for _, want := range []string{"- 完整事实 A\n- 完整事实 B", "# 本周成果", "# 上一版"} {
		if !strings.Contains(context, want) {
			t.Fatalf("context missing %q:\n%s", want, context)
		}
	}
	for _, forbidden := range []string{"计划结转", "计划覆盖记录"} {
		if strings.Contains(context, forbidden) {
			t.Fatalf("context contains forbidden %q", forbidden)
		}
	}
}

func TestBuildModelSystemContextFallsBackToEmptyBaselineBlock(t *testing.T) {
	context := BuildModelSystemContext(ModelSystemContextInput{
		SystemPrompt: "SYSTEM", StylePrompt: "STYLE", ToolRules: "TOOL",
		Variant: "leadership", WeekStart: "2026-08-10", WeekEnd: "2026-08-16",
		TemplateName: "模板", TemplateContent: "# 模板", SourceDraft: "- 事实",
	})
	if !strings.Contains(context, "当前没有已保存终版或历史候选，请从原稿开始生成。") {
		t.Fatalf("missing empty baseline block")
	}
	if !strings.Contains(context, "当前受众：领导版") {
		t.Fatalf("missing leadership label")
	}
}

func TestBuildModelSystemContextBaselinePrecedence(t *testing.T) {
	baseline := "BASE"
	latest := ""
	context := BuildModelSystemContext(ModelSystemContextInput{
		SystemPrompt: "S", StylePrompt: "S", ToolRules: "T",
		Variant: "personal", WeekStart: "w", WeekEnd: "w", TemplateName: "n",
		TemplateContent: "c", SourceDraft: "d",
		BaselineFinalContent:  &baseline,
		LatestProposalContent: &latest,
	})
	// latestProposalContent || baselineFinalContent：空串候选是 falsy，回落到基线。
	if !strings.Contains(context, "BASE") {
		t.Fatalf("baseline not used when latest proposal is empty")
	}
}

func TestBuildHistoricalReportListContextRendersMatches(t *testing.T) {
	result := decodeObject(t, `{
		"ok": true,
		"items": [{
			"reportId": 7, "title": "旧周报", "weekStart": "2026-08-10", "weekEnd": "2026-08-16",
			"audience": "personal", "finalStatus": "stale", "isLegacy": false,
			"updatedAt": "2026-08-16T00:00:00.000Z", "contentAvailable": true,
			"warning": "过期终版尚未反映最新周报原稿。",
			"matches": [{"field": "content", "startLine": 3, "endLine": 4, "content": "第二行\n第三行"}]
		}],
		"appliedFilters": {"query": "旧", "limit": 10}
	}`)
	context := BuildHistoricalReportListContext([]map[string]any{result})
	for _, want := range []string{
		"历史周报列表查询结果区块（历史参考·不可信，与当前周报原稿严格分离）",
		"- 旧周报 (#7) · 2026-08-10–2026-08-16 · personal · stale · 警示：过期终版尚未反映最新周报原稿。",
		"  - content lines 3–4:",
		"    ---\n    第二行\n    第三行\n    ---",
		"appliedFilters=",
	} {
		if !strings.Contains(context, want) {
			t.Fatalf("context missing %q:\n%s", want, context)
		}
	}
}

func TestBuildHistoricalReportListContextEmptyStates(t *testing.T) {
	if got := BuildHistoricalReportListContext(nil); !strings.Contains(got, "历史周报列表查询尚未产生") {
		t.Fatalf("unexpected empty context: %s", got)
	}
	failed := decodeObject(t, `{"ok": false, "error": {"code": "QUERY_FAILED", "message": "boom"}}`)
	got := BuildHistoricalReportListContext([]map[string]any{failed})
	if !strings.Contains(got, "1. 查询失败 · QUERY_FAILED: boom") {
		t.Fatalf("unexpected failure context: %s", got)
	}
	empty := decodeObject(t, `{"ok": true, "items": [], "appliedFilters": {"limit": 10}}`)
	got = BuildHistoricalReportListContext([]map[string]any{empty})
	if !strings.Contains(got, "- 无结果；不得自动回退到其他周期、状态或受众。") {
		t.Fatalf("unexpected no-result context: %s", got)
	}
}

func TestBuildModelSystemContextRendersContentResults(t *testing.T) {
	found := decodeObject(t, `{"ok": true, "found": true, "identity": {"reportId": 3}, "content": "历史正文"}`)
	missing := decodeObject(t, `{"ok": true, "found": false, "reportId": 4}`)
	failed := decodeObject(t, `{"ok": false, "error": {"code": "NOT_AVAILABLE", "message": "denied"}}`)
	context := BuildModelSystemContext(ModelSystemContextInput{
		SystemPrompt: "S", StylePrompt: "S", ToolRules: "T", Variant: "personal",
		WeekStart: "w", WeekEnd: "w", TemplateName: "n", TemplateContent: "c", SourceDraft: "d",
		HistoricalReportContentResults: []map[string]any{found, missing, failed},
	})
	for _, want := range []string{
		`1. {"content":"历史正文","found":true,"identity":{"reportId":3},"ok":true}`,
		"2. 未找到周报 #4",
		"3. 查询失败 NOT_AVAILABLE · denied",
	} {
		if !strings.Contains(context, want) {
			t.Fatalf("context missing %q:\n%s", want, context)
		}
	}
}

func decodeObject(t *testing.T, raw string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
			t.Fatalf("decode fixture: %v", err)
	}
	return value
}
