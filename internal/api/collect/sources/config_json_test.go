package sources

import (
	"encoding/json"
	"testing"
)

// TestMergeEditedBranchesMatchesSourceLib 的用例集取自 src/lib/collect/branches.test.ts
// 的 mergeEditedBranches 三条（该 vitest 文件保留：这些函数被 client 代码 import，
// 按 ADR-0029 属于「被 client import 的纯函数 → 留 vitest」；这里只为 route 的
// 分支合并路径补一份 Go 侧对照）。

func TestMergeEditedBranchesPreservesCursors(t *testing.T) {
	existing := []byte(`{"branches":[{"name":"main","lastCommitTime":"2026-08-24T10:00:00.000Z"},"develop"]}`)
	edited := []branchEntry{
		{Name: "main"},
		{Name: "release"},
	}

	merged, ok, err := mergeEditedBranches(existing, edited, true)
	if err != nil {
		t.Fatalf("mergeEditedBranches: %v", err)
	}
	if !ok {
		t.Fatal("expected a non-empty result")
	}
	if len(merged) != 2 {
		t.Fatalf("merged = %+v", merged)
	}
	if merged[0].Name != "main" || merged[0].LastCommitTime == nil || *merged[0].LastCommitTime != "2026-08-24T10:00:00.000Z" {
		t.Fatalf("merged[0] = %+v", merged[0])
	}
	if merged[1].Name != "release" || merged[1].LastCommitTime != nil {
		t.Fatalf("merged[1] = %+v", merged[1])
	}
}

func TestMergeEditedBranchesTrimsAndDeduplicates(t *testing.T) {
	edited := []branchEntry{{Name: " main "}, {Name: ""}, {IsString: true, String: "main"}}

	merged, ok, err := mergeEditedBranches(nil, edited, true)
	if err != nil {
		t.Fatalf("mergeEditedBranches: %v", err)
	}
	if !ok || len(merged) != 1 {
		t.Fatalf("merged = %+v ok=%v", merged, ok)
	}
	if merged[0].Name != "main" || merged[0].LastCommitTime != nil {
		t.Fatalf("merged[0] = %+v", merged[0])
	}
}

func TestMergeEditedBranchesReturnsUndefinedForEmptyConfig(t *testing.T) {
	existing := []byte(`{"branches":[{"name":"main","lastCommitTime":"2026-08-24T10:00:00.000Z"}]}`)

	merged, ok, err := mergeEditedBranches(existing, nil, true)
	if err != nil {
		t.Fatalf("mergeEditedBranches: %v", err)
	}
	if ok || merged != nil {
		t.Fatalf("merged = %+v ok=%v, want undefined", merged, ok)
	}
}

// TestPreservedBranchCursorsNormalizes 复刻 `{name, lastCommitTime: c.lastCommitTime ?? null}`。
func TestPreservedBranchCursorsNormalizes(t *testing.T) {
	raw := []byte(`{"branchCursors":[{"name":"main"},{"name":"dev","lastCommitTime":"2026-01-01T00:00:00.000Z"}]}`)

	cursors, ok, err := preservedBranchCursors(raw)
	if err != nil {
		t.Fatalf("preservedBranchCursors: %v", err)
	}
	if !ok || len(cursors) != 2 {
		t.Fatalf("cursors = %+v ok=%v", cursors, ok)
	}
	if string(cursors[0]) != `{"name":"main","lastCommitTime":null}` {
		t.Fatalf("cursors[0] = %s", cursors[0])
	}
	if string(cursors[1]) != `{"name":"dev","lastCommitTime":"2026-01-01T00:00:00.000Z"}` {
		t.Fatalf("cursors[1] = %s", cursors[1])
	}
}

func TestPreservedBranchCursorsAbsent(t *testing.T) {
	cursors, ok, err := preservedBranchCursors([]byte(`{"owner":"/a"}`))
	if err != nil {
		t.Fatalf("preservedBranchCursors: %v", err)
	}
	if ok || cursors != nil {
		t.Fatalf("cursors = %+v ok=%v", cursors, ok)
	}
}

// TestSetNormalizedBranchesSerializesShape 确认 branches 归一后的落库形状。
func TestSetNormalizedBranchesSerializesShape(t *testing.T) {
	obj := newOrderedObject()
	setNormalizedBranches(obj, "branches", []branchCursorEntry{{Name: "main"}, {Name: "dev", LastCommitTime: stringPointer("2026-01-01T00:00:00.000Z")}})

	encoded, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"branches":[{"name":"main","lastCommitTime":null},{"name":"dev","lastCommitTime":"2026-01-01T00:00:00.000Z"}]}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s, want %s", encoded, want)
	}
}

func stringPointer(value string) *string { return &value }
