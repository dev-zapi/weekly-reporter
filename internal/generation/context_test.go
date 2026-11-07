package generation_test

import (
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/generation"
)

// 期望值由 src/lib/generation/context.ts 的 buildSourceOverview 直接跑出来的
// 字符串（同一输入 → 同一输出），对照 ADR-0029 的「同断言集」要求。

func TestBuildSourceOverview(t *testing.T) {
	cases := []struct {
		name     string
		draft    string
		variant  string
		expected string
	}{
		{
			name:     "leadership keeps repository count and event order",
			draft:    "- **repo-one**\n  - first event\n  - second event\n- manual event",
			variant:  "leadership",
			expected: "领导版 source draft: 3 events. 1 repositories/projects: repo-one.\n1. first event\n2. second event\n3. manual event",
		},
		{
			name:     "personal uses the personal label",
			draft:    "- **repo-one**\n  - first event\n  - second event\n- manual event",
			variant:  "personal",
			expected: "个人版 source draft: 3 events. 1 repositories/projects: repo-one.\n1. first event\n2. second event\n3. manual event",
		},
		{
			name:     "empty english draft is still an event line",
			draft:    "- No events this week",
			variant:  "personal",
			expected: "个人版 source draft: 1 events. No repository groups identified.\n1. No events this week",
		},
		{
			name:     "legacy chinese empty draft is still an event line",
			draft:    "- 本周暂无事件",
			variant:  "leadership",
			expected: "领导版 source draft: 1 events. No repository groups identified.\n1. 本周暂无事件",
		},
		{
			name:     "bold-only line is a repository, so there are no usable events",
			draft:    "- **bold only**",
			variant:  "personal",
			expected: "个人版 source draft: No usable events this week.",
		},
		{
			name:     "trailing blank lines are ignored",
			draft:    "- **repo**\n  - a\n\n  ",
			variant:  "leadership",
			expected: "领导版 source draft: 1 events. 1 repositories/projects: repo.\n1. a",
		},
		{
			name:     "more than five events are omitted from the preview",
			draft:    "- event 1\n- event 2\n- event 3\n- event 4\n- event 5\n- event 6\n- event 7\n- event 8",
			variant:  "personal",
			expected: "个人版 source draft: 8 events. No repository groups identified.\n1. event 1\n2. event 2\n3. event 3\n4. event 4\n5. event 5\n3 more events omitted from the overview.",
		},
		{
			// 88 个 UTF-16 码元的截断（CJK 每字 1 个码元）+ 省略号。
			name:     "long events are clipped at 88 UTF-16 units",
			draft:    "- " + repeatRune('字', 100),
			variant:  "leadership",
			expected: "领导版 source draft: 1 events. No repository groups identified.\n1. " + repeatRune('字', 88) + "…",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := generation.BuildSourceOverview(tc.draft, tc.variant)
			if got != tc.expected {
				t.Fatalf("got  %q\nwant %q", got, tc.expected)
			}
		})
	}
}

// 折叠空白：`event.replace(/\s+/g, ' ').trim()`（含全角空格 U+3000）。
func TestBuildSourceOverviewCollapsesWhitespace(t *testing.T) {
	got := generation.BuildSourceOverview("- a \t\t b　c", "personal")
	want := "个人版 source draft: 1 events. No repository groups identified.\n1. a b c"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func repeatRune(value rune, count int) string {
	out := make([]rune, count)
	for index := range out {
		out[index] = value
	}
	return string(out)
}
