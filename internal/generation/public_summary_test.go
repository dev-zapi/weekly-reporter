package generation_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/generation"
)

// normalizePublicGenerationSummary 的形状校验（src/lib/generation/public-summary.ts）。

const validSummary = `{
  "version": 1,
  "modelHandling": ["整理原稿"],
  "historicalReferences": [],
  "toolStatuses": [{"toolName":"propose_final_report","status":"succeeded","detail":"proposal-created"}],
  "failureStates": [],
  "truncationStates": [],
  "changeSummary": ["首轮"],
  "factBoundary": {"currentWeekFacts":"report-source-draft-only"}
}`

func TestNormalizePublicGenerationSummaryValid(t *testing.T) {
	got := generation.NormalizePublicGenerationSummary(json.RawMessage(validSummary))
	if string(got) == "null" {
		t.Fatalf("valid summary normalized to null")
	}
	var decoded map[string]any
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	if decoded["changeSummary"].([]any)[0] != "首轮" {
		t.Fatalf("decoded = %v", decoded)
	}
}

func TestNormalizePublicGenerationSummaryRejectsInvalidShapes(t *testing.T) {
	cases := map[string]string{
		"null":                  `null`,
		"empty":                 ``,
		"wrong version":         strings.Replace(validSummary, `"version": 1`, `"version": 2`, 1),
		"missing modelHandling": strings.Replace(validSummary, `"modelHandling": ["整理原稿"],`, "", 1),
		"missing changeSummary": strings.Replace(validSummary, `"changeSummary": ["首轮"],`, "", 1),
		"not an object":         `[]`,
		"invalid json":          `{"version":`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if got := generation.NormalizePublicGenerationSummary(json.RawMessage(raw)); string(got) != "null" {
				t.Fatalf("got %s, want null", got)
			}
		})
	}
}

// proposalReferenceChanged：pending 且存在更新的 user 触发快照才算参考已变。
func TestProposalReferenceChanged(t *testing.T) {
	snapshots := []generation.QuerySnapshotJSON{
		{Trigger: "automatic", CreatedAt: "2026-08-10T10:00:01.000Z"},
	}

	if generation.ProposalReferenceChanged("pending", "2026-08-10T10:00:00.000Z", snapshots) {
		t.Fatal("automatic snapshots must not mark the reference as changed")
	}
	if generation.ProposalReferenceChanged("accepted", "2026-08-10T10:00:00.000Z", []generation.QuerySnapshotJSON{
		{Trigger: "user", CreatedAt: "2026-08-10T10:00:01.000Z"},
	}) {
		t.Fatal("non-pending proposals are never reference-changed")
	}
	if !generation.ProposalReferenceChanged("pending", "2026-08-10T10:00:00.000Z", []generation.QuerySnapshotJSON{
		{Trigger: "user", CreatedAt: "2026-08-10T10:00:01.000Z"},
	}) {
		t.Fatal("newer user snapshot must mark the reference as changed")
	}
	// 同一秒的 user 快照不算更新（createdAt > proposal.createdAt 是严格大于）。
	if generation.ProposalReferenceChanged("pending", "2026-08-10T10:00:00.000Z", []generation.QuerySnapshotJSON{
		{Trigger: "user", CreatedAt: "2026-08-10T10:00:00.000Z"},
	}) {
		t.Fatal("same-second snapshot must not count as newer")
	}
}
