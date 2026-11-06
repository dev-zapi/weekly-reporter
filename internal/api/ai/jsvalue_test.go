package ai

import (
	"math"
	"testing"
)

// 本文件的期望值全部由 Node 实测得到（`Number.parseFloat(v)`、`String(v)`、
// `[...].join(sep)`），枚举的是 ai_styles.temperature 与提示词拼接真正会遇到的
// 输入形态。

func TestParseFloatMatchesJavaScript(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"0.3", 0.3},
		{"0", 0},
		{"1", 1},
		{" 0.7 ", 0.7},
		{"\t0.5\n", 0.5},
		{"0.3abc", 0.3},
		{"abc", math.NaN()},
		{"", math.NaN()},
		{"   ", math.NaN()},
		{"-0.5", -0.5},
		{"+0.5", 0.5},
		{".5", 0.5},
		{"5.", 5},
		{"1e2", 100},
		{"1e", 1},
		{"1e+2", 100},
		{"0.25e-1", 0.025},
		{"0x10", 0},
		{"Infinity", math.Inf(1)},
		{"-Infinity", math.Inf(-1)},
		{"inf", math.NaN()},
		{"NaN", math.NaN()},
	}

	for _, tc := range cases {
		got := parseFloatJS(tc.in)
		if math.IsNaN(tc.want) {
			if !math.IsNaN(got) {
				t.Errorf("parseFloatJS(%q) = %v, want NaN", tc.in, got)
			}
			continue
		}
		if got != tc.want {
			t.Errorf("parseFloatJS(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestNumberToStringMatchesJavaScript(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{1, "1"},
		{-1, "-1"},
		{1.5, "1.5"},
		{2, "2"},
		{1e21, "1e+21"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
	}
	for _, tc := range cases {
		if got := jsNumberToString(tc.in); got != tc.want {
			t.Errorf("jsNumberToString(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Array.prototype.join：null/undefined 元素变空串，其余走 String()。
func TestJoinMatchesJavaScript(t *testing.T) {
	got := jsJoin([]any{"a", nil, 1.0, true, ""}, "\n")
	if want := "a\n\n1\ntrue\n"; got != want {
		t.Fatalf("jsJoin = %q, want %q", got, want)
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
