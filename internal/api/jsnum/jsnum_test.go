package jsnum

import (
	"math"
	"testing"
)

// 期望值全部由 Node 24 实测（`String(v)` / `parseFloat(s)`）。

func TestFormatNumberMatchesJS(t *testing.T) {
	cases := []struct {
		value float64
		want  string
	}{
		{0, "0"},
		{math.Copysign(0, -1), "0"},
		{1, "1"},
		{2, "2"},
		{1.5, "1.5"},
		{0.3, "0.3"},
		{0.7, "0.7"},
		{0.4, "0.4"},
		{0.5, "0.5"},
		{0.2, "0.2"},
		{0.30000000000000004, "0.30000000000000004"},
		{123.456, "123.456"},
		{0.000001, "0.000001"},
		{0.0000001, "1e-7"},
		{1.5e-7, "1.5e-7"},
		{1.5e-8, "1.5e-8"},
		{1e21, "1e+21"},
		{-1, "-1"},
		{-0.3, "-0.3"},
		{-1e-7, "-1e-7"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
	}
	for _, tc := range cases {
		if got := FormatNumber(tc.value); got != tc.want {
			t.Fatalf("FormatNumber(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestParseFloatMatchesJS(t *testing.T) {
	cases := []struct {
		input string
		want  float64
		ok    bool
	}{
		{"0.3", 0.3, true},
		{"0.30000000000000004", 0.30000000000000004, true},
		{"1", 1, true},
		{" 2.5", 2.5, true},
		{"\t-1.5\n", -1.5, true},
		{"0.3abc", 0.3, true},
		{"1e3", 1000, true},
		{"1e", 1, true},   // 指数不完整 → 不消费 'e'
		{"1e+", 1, true},  // 同上
		{".5", 0.5, true}, // 允许省略整数部分
		{"5.", 5, true},
		{"Infinity", math.Inf(1), true},
		{"-Infinity", math.Inf(-1), true},
		{"", 0, false},
		{"abc", 0, false},
		{"  ", 0, false},
		{"0x10", 0, true}, // parseFloat 只消费开头的 "0"
		{"-.5", -0.5, true},
		{"+0.5", 0.5, true},
		{"1e2", 100, true},
		{"1e+2", 100, true},
		{"0.25e-1", 0.025, true},
		{"inf", 0, false},
		{"NaN", 0, false},
	}
	for _, tc := range cases {
		got, ok := ParseFloat(tc.input)
		if ok != tc.ok {
			t.Fatalf("ParseFloat(%q) ok = %v, want %v", tc.input, ok, tc.ok)
		}
		if !tc.ok {
			continue
		}
		if math.IsInf(tc.want, 0) {
			if got != tc.want {
				t.Fatalf("ParseFloat(%q) = %v, want %v", tc.input, got, tc.want)
			}
			continue
		}
		if got != tc.want {
			t.Fatalf("ParseFloat(%q) = %v, want %v", tc.input, got, tc.want)
		}
	}
}
