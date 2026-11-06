package tools

import (
	"encoding/json"
	"reflect"
	"testing"
)

// 用例逐条对照 src/lib/generation/generation-tools.test.ts（票 #108「测试随票走」
// 清单里 generation-tools.test.ts 的 server-only 用例转 Go 单测）。

func TestProposeSchemaRendersCanonicalVisibleSchema(t *testing.T) {
	// 用例 1：可见 schema 不得泄漏 anyOf/oneOf，summary 与 publicSummary 的
	// 描述文本逐字一致。
	var schema map[string]any
	if err := json.Unmarshal([]byte(ProposeFinalReportInputJSONSchema), &schema); err != nil {
		t.Fatalf("unmarshal schema: %v", err)
	}
	properties := schema["properties"].(map[string]any)

	if !reflect.DeepEqual(properties["summary"], map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string"},
		"description": "面向用户的简短变更摘要",
	}) {
		t.Fatalf("summary schema = %#v", properties["summary"])
	}

	publicSummary := properties["publicSummary"].(map[string]any)
	for _, forbidden := range []string{"anyOf", "oneOf"} {
		if _, present := publicSummary[forbidden]; present {
			t.Fatalf("publicSummary leaks %s: %#v", forbidden, publicSummary)
		}
	}
	if publicSummary["type"] != "object" {
		t.Fatalf("publicSummary.type = %v", publicSummary["type"])
	}
	if !reflect.DeepEqual(publicSummary["properties"], map[string]any{
		"modelHandling": map[string]any{
			"type":        "array",
			"items":       map[string]any{"type": "string"},
			"description": "模型显式提供的简短处理说明；不得复制历史正文或推测隐藏推理",
		},
	}) {
		t.Fatalf("publicSummary.properties = %#v", publicSummary["properties"])
	}
}

func TestProposeSchemaCoercesBareStringSummary(t *testing.T) {
	input, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":"hello"}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !reflect.DeepEqual(input.Summary, []string{"hello"}) {
		t.Fatalf("summary = %#v", input.Summary)
	}
}

func TestProposeSchemaLeavesArraySummaryUnchanged(t *testing.T) {
	input, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["a","b"]}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !reflect.DeepEqual(input.Summary, []string{"a", "b"}) {
		t.Fatalf("summary = %#v", input.Summary)
	}
}

func TestProposeSchemaCoercesBareStringArrayPublicSummary(t *testing.T) {
	input, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"publicSummary":["x"]}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if input.PublicSummary == nil || !reflect.DeepEqual(input.PublicSummary.ModelHandling, []string{"x"}) {
		t.Fatalf("publicSummary = %#v", input.PublicSummary)
	}
}

func TestProposeSchemaPassesStructuredPublicSummaryUnchanged(t *testing.T) {
	input, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"publicSummary":{"modelHandling":["y"]}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if input.PublicSummary == nil || !reflect.DeepEqual(input.PublicSummary.ModelHandling, []string{"y"}) {
		t.Fatalf("publicSummary = %#v", input.PublicSummary)
	}
}

func TestProposeSchemaRejectsLegacyPlanJudgments(t *testing.T) {
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"planJudgments":[]}`)); err == nil {
		t.Fatal("expected strictObject to reject planJudgments")
	}
}

func TestProposeSchemaRejectsLegacyPlanItems(t *testing.T) {
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"planItems":[]}`)); err == nil {
		t.Fatal("expected strictObject to reject planItems")
	}
}

func TestProposeSchemaRejectsRemovedPlanParameter(t *testing.T) {
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"plan":{"items":[]}}`)); err == nil {
		t.Fatal("expected strictObject to reject plan")
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(ProposeFinalReportInputJSONSchema), &schema); err != nil {
		t.Fatalf("unmarshal schema: %v", err)
	}
	if _, present := schema["properties"].(map[string]any)["plan"]; present {
		t.Fatal("plan must not appear in the visible schema")
	}
}

func TestProposeSchemaRejectsBareStringPublicSummary(t *testing.T) {
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"publicSummary":"oops"}`)); err == nil {
		t.Fatal("expected a bare string publicSummary to be rejected")
	}
}

func TestProposeSchemaRequiresContent(t *testing.T) {
	if _, err := ParseProposeFinalReportInput([]byte(`{"summary":["s"]}`)); err == nil {
		t.Fatal("expected content to be required")
	}
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"","summary":["s"]}`)); err == nil {
		t.Fatal("expected an empty content to be rejected")
	}
}

func TestProposeSchemaRejectsUnknownTopLevelKeys(t *testing.T) {
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"extra":1}`)); err == nil {
		t.Fatal("expected strictObject to reject unknown keys")
	}
}

func TestProposeSchemaDropsUnknownPublicSummaryKeys(t *testing.T) {
	// z.object（非 strict）剥掉未知键而不是报错。
	input, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":["s"],"publicSummary":{"modelHandling":["y"],"extra":1}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if input.PublicSummary == nil || !reflect.DeepEqual(input.PublicSummary.ModelHandling, []string{"y"}) {
		t.Fatalf("publicSummary = %#v", input.PublicSummary)
	}
}

func TestProposeSchemaAcceptsEmptySummaryArray(t *testing.T) {
	// z.array(z.string()) 没有 min(1)，空数组合法。
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":[]}`)); err != nil {
		t.Fatalf("parse: %v", err)
	}
}

func TestProposeSchemaRejectsNonStringSummaryScalar(t *testing.T) {
	// 数字被 preprocess 包成 [5]，再被元素类型拒绝。
	if _, err := ParseProposeFinalReportInput([]byte(`{"content":"x","summary":5}`)); err == nil {
		t.Fatal("expected a numeric summary to be rejected")
	}
}
