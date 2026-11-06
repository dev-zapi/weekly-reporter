package ai

import (
	"math"
	"testing"
)

// 本文件的期望值全部由 Node 实测得到（`[...].join(sep)`），枚举的是提示词拼接
// 真正会遇到的输入形态。数值语义（Number::toString / parseFloat）的统一实现与
// 对照 V8 的用例在 internal/api/jsnum，这里只钉住本域的可观测拼接结果。

// Array.prototype.join：null/undefined 元素变空串，其余走 String()。
func TestJoinMatchesJavaScript(t *testing.T) {
	got := jsJoin([]any{"a", nil, 1.0, true, ""}, "\n")
	if want := "a\n\n1\ntrue\n"; got != want {
		t.Fatalf("jsJoin = %q, want %q", got, want)
	}

	// 指数区间的数字也按 JS 的 Number::toString 拼接：1e-7 而不是 Go 的 1e-07。
	// expand-section 把 existingItems/events 直接 join 进提示词，这里的偏差会
	// 进入发给 provider 的请求体。
	if got, want := jsJoin([]any{1e-7, 1.5e-8}, "\n"), "1e-7\n1.5e-8"; got != want {
		t.Fatalf("jsJoin(numbers) = %q, want %q", got, want)
	}

	if got := jsJoin(nil, "\n"); got != "" {
		t.Fatalf("jsJoin(nil) = %q, want empty", got)
	}
}

func TestTruthyMatchesJavaScript(t *testing.T) {
	cases := []struct {
		in   any
		want bool
	}{
		{nil, false},
		{false, false},
		{true, true},
		{"", false},
		{"x", true},
		{0.0, false},
		{1.0, true},
		{math.NaN(), false},
		{[]any{}, true},
		{map[string]any{}, true},
	}
	for _, tc := range cases {
		if got := truthyJSON(tc.in); got != tc.want {
			t.Errorf("truthyJSON(%#v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// drizzle 把 JSON 值绑进 integer 主键时看得见的两类输入。
func TestAsIDMatchesDrizzleBinding(t *testing.T) {
	cases := []struct {
		in   any
		want int64
		ok   bool
	}{
		{1.0, 1, true},
		{1.5, 0, false},
		{"1", 1, true},
		{" 1 ", 1, true},
		{"1abc", 0, false},
		{"", 0, false},
		{math.NaN(), 0, false},
		{math.Inf(1), 0, false},
	}
	for _, tc := range cases {
		got, ok := asID(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("asID(%#v) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
