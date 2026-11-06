package reports_test

import (
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/reports"
	"github.com/dev-zapi/weekly-reporter/internal/template"
)

// 用例集对照 src/lib/reports/source-draft.test.ts（该 vitest 保留：source-draft.ts
// 同时被 client 组件 import，按 ADR-0029 的边界留在 vitest）。

func draftEvent(id int64, eventTime int64, source, content string, sourceID *int64, repo string) reports.DraftEvent {
	return reports.DraftEvent{
		ID:        &id,
		EventTime: eventTime,
		Source:    source,
		Content:   content,
		SourceID:  sourceID,
		Repo:      repo,
	}
}

func ptr(value int64) *int64 { return &value }

func TestBuildSourceDraftKeepsOriginPriorityAndRepoNesting(t *testing.T) {
	events := []reports.DraftEvent{
		draftEvent(1, 1_700_000_000, "git-remote-github", "个人项目", ptr(2), "personal-repo"),
		draftEvent(2, 1_700_000_100, "git-remote-github", "工作项目", ptr(1), "work-repo"),
		draftEvent(3, 1_700_000_200, "manual", "手动重点", nil, ""),
	}
	scopes := map[int64]template.ProjectScope{1: template.ScopeWork, 2: template.ScopePersonal}

	leadership := reports.BuildSourceDraft(events, "leadership", scopes)
	personal := reports.BuildSourceDraft(events, "personal", scopes)

	if !contains(leadership, "手动重点") || !contains(leadership, "work-repo") {
		t.Fatalf("leadership = %q", leadership)
	}
	if contains(leadership, "personal-repo") {
		t.Fatalf("leadership = %q, must not include personal repo", leadership)
	}
	if !contains(personal, "personal-repo") {
		t.Fatalf("personal = %q, want personal repo", personal)
	}
	if indexOf(personal, "手动重点") > indexOf(personal, "work-repo") {
		t.Fatalf("personal = %q, want manual before work repo", personal)
	}
	// 仓库分组带缩进子项。
	if !contains(personal, "- **work-repo**\n  - 工作项目") {
		t.Fatalf("personal = %q, want nested repo item", personal)
	}
}

func TestBuildSourceDraftReturnsExplicitEmptyDraft(t *testing.T) {
	if got := reports.BuildSourceDraft(nil, "personal", nil); got != "- No events this week" {
		t.Fatalf("got %q", got)
	}
}

// 快照行按已存的分类字段过滤（不查 sourceScopes）。
func TestBuildSourceDraftUsesSnapshotClassification(t *testing.T) {
	personalScope := template.ScopePersonal
	workScope := template.ScopeWork
	events := []reports.DraftEvent{
		{ID: ptr(1), EventTime: 1_700_000_000, Source: "manual", Content: "手动", Snapshot: true, LeadershipIncluded: true, PersonalIncluded: true},
		{ID: ptr(2), EventTime: 1_700_000_100, Source: "git-local", Content: "个人仓库", Repo: "p", Snapshot: true, ProjectScope: &personalScope, LeadershipIncluded: false, PersonalIncluded: true},
		{ID: ptr(3), EventTime: 1_700_000_200, Source: "git-local", Content: "工作仓库", Repo: "w", Snapshot: true, ProjectScope: &workScope, LeadershipIncluded: true, PersonalIncluded: true},
	}

	leadership := reports.BuildSourceDraft(events, "leadership", nil)
	if contains(leadership, "个人仓库") {
		t.Fatalf("leadership = %q, must exclude personal snapshot", leadership)
	}
	if !contains(leadership, "工作仓库") {
		t.Fatalf("leadership = %q, want work snapshot", leadership)
	}

	personal := reports.BuildSourceDraft(events, "personal", nil)
	if !contains(personal, "个人仓库") || !contains(personal, "工作仓库") {
		t.Fatalf("personal = %q, want both repos", personal)
	}
}

func TestIsEmptySourceDraft(t *testing.T) {
	if !reports.IsEmptySourceDraft("- No events this week") {
		t.Fatal("English empty draft not detected")
	}
	if !reports.IsEmptySourceDraft("- 本周暂无事件") {
		t.Fatal("legacy Chinese empty draft not detected")
	}
	if reports.IsEmptySourceDraft("- 有内容") {
		t.Fatal("non-empty draft detected as empty")
	}
}

func TestClassifyEventForVariants(t *testing.T) {
	scopes := map[int64]template.ProjectScope{1: template.ScopeWork, 2: template.ScopePersonal}

	manual := reports.ClassifyEventForVariants(nil, scopes)
	if manual.OriginGroup != template.GroupManual || manual.ProjectScope != nil || !manual.LeadershipIncluded || !manual.PersonalIncluded {
		t.Fatalf("manual = %+v", manual)
	}

	work := reports.ClassifyEventForVariants(ptr(1), scopes)
	if *work.ProjectScope != template.ScopeWork || !work.LeadershipIncluded {
		t.Fatalf("work = %+v", work)
	}

	personal := reports.ClassifyEventForVariants(ptr(2), scopes)
	if *personal.ProjectScope != template.ScopePersonal || personal.LeadershipIncluded {
		t.Fatalf("personal = %+v", personal)
	}

	// 未命中的 sourceId 归 other：没有项目范围，也不进领导版。
	other := reports.ClassifyEventForVariants(ptr(9), scopes)
	if other.OriginGroup != template.GroupOther || other.ProjectScope != nil || other.LeadershipIncluded {
		t.Fatalf("other = %+v", other)
	}
}

func contains(haystack, needle string) bool {
	return indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}

func TestSliceUTF16(t *testing.T) {
	if got := reports.SliceUTF16("abcdef", 3); got != "abc" {
		t.Fatalf("got %q", got)
	}
	// 增补平面字符占两个 UTF-16 码元，且不会被劈开。
	if got := reports.SliceUTF16("a😀b", 2); got != "a" {
		t.Fatalf("got %q", got)
	}
	if got := reports.SliceUTF16("a😀b", 3); got != "a😀" {
		t.Fatalf("got %q", got)
	}
}

// 以下期望值由 src/lib/reports/source-draft.ts 的 buildSourceDraft 直接跑出
// （同一输入 → 同一输出），固化排序、分组与过滤的逐字节对等。
func TestBuildSourceDraftMatchesTSOutput(t *testing.T) {
	base := int64(1767225600) // 2026-01-01T00:00:00Z

	cases := []struct {
		name     string
		events   []reports.DraftEvent
		variant  string
		scopes   map[int64]template.ProjectScope
		expected string
	}{
		{
			name:     "single manual event",
			events:   []reports.DraftEvent{draftEvent(1, base+100, "manual", "手动", nil, "")},
			variant:  "leadership",
			expected: "- 手动",
		},
		{
			name: "repo group sorts events by time desc",
			events: []reports.DraftEvent{
				draftEvent(1, base+100, "git-local", "a", nil, "r"),
				draftEvent(2, base+200, "git-local", "b", nil, "r"),
				draftEvent(3, base+50, "git-local", "c", nil, "r"),
			},
			variant:  "personal",
			expected: "- **r**\n  - b\n  - a\n  - c",
		},
		{
			name: "leadership keeps manual before work and drops personal",
			events: []reports.DraftEvent{
				draftEvent(1, base+100, "git-local", "w", ptr(1), "wr"),
				draftEvent(2, base+90, "git-local", "p", ptr(2), "pr"),
				draftEvent(3, base+80, "manual", "m", nil, ""),
			},
			variant:  "leadership",
			scopes:   map[int64]template.ProjectScope{1: template.ScopeWork, 2: template.ScopePersonal},
			expected: "- m\n- **wr**\n  - w",
		},
		{
			name: "personal keeps every scope",
			events: []reports.DraftEvent{
				draftEvent(1, base+100, "git-local", "w", ptr(1), "wr"),
				draftEvent(2, base+90, "git-local", "p", ptr(2), "pr"),
				draftEvent(3, base+80, "manual", "m", nil, ""),
			},
			variant:  "personal",
			scopes:   map[int64]template.ProjectScope{1: template.ScopeWork, 2: template.ScopePersonal},
			expected: "- m\n- **wr**\n  - w\n- **pr**\n  - p",
		},
		{
			name:     "empty repo name falls out of the repo group",
			events:   []reports.DraftEvent{draftEvent(1, base+100, "github", "x", ptr(1), "")},
			variant:  "personal",
			scopes:   map[int64]template.ProjectScope{1: template.ScopeWork},
			expected: "- x",
		},
		{
			name: "unmapped source ranks below work",
			events: []reports.DraftEvent{
				draftEvent(1, base+100, "git-remote-github", "s", ptr(9), "r1"),
				draftEvent(2, base+100, "git-local", "t", ptr(1), "r0"),
			},
			variant:  "leadership",
			scopes:   map[int64]template.ProjectScope{1: template.ScopeWork},
			expected: "- **r0**\n  - t",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reports.BuildSourceDraft(tc.events, tc.variant, tc.scopes); got != tc.expected {
				t.Fatalf("got  %q\nwant %q", got, tc.expected)
			}
		})
	}
}
