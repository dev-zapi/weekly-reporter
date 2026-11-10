package engine

import (
	"encoding/json"
	"strings"
	"testing"
)

// reportListToolSchema 是发给 provider 的 JSON Schema；参数描述必须让生成会话
// 里的 AI 第一次就能构造合法日期参数（#140）。
func TestReportListToolSchemaDocumentsOffsetTimestamps(t *testing.T) {
	var parameters json.RawMessage
	description := ""
	for _, tool := range toolDefinitions() {
		if tool.Name == reportListToolName {
			parameters = tool.Parameters
			description = tool.Description
			break
		}
	}
	if len(parameters) == 0 {
		t.Fatal("query_report_list tool definition not found")
	}

	var schema struct {
		Properties map[string]struct {
			Description string `json:"description"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(parameters, &schema); err != nil {
		t.Fatalf("unmarshal schema: %v", err)
	}

	examples := map[string]string{
		"startDate": "2026-11-03T00:00:00+08:00",
		"endDate":   "2026-11-09T23:59:59+08:00",
	}
	for _, field := range []string{"startDate", "endDate"} {
		property, ok := schema.Properties[field]
		if !ok {
			t.Fatalf("schema missing %s", field)
		}
		for _, want := range []string{"RFC3339", examples[field]} {
			if !strings.Contains(property.Description, want) {
				t.Fatalf("%s description = %q, want it to contain %q", field, property.Description, want)
			}
		}
	}
	for _, want := range []string{"RFC3339", "2026-11-03T00:00:00+08:00"} {
		if !strings.Contains(description, want) {
			t.Fatalf("tool description = %q, want it to contain %q", description, want)
		}
	}
}
