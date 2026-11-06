package settings

import "testing"

// 本文件的期望值由 Node 24 的 `Array.prototype.sort()` / `String(value)` 实测
// 得到：默认比较器按 UTF-16 码元序，undefined 元素（JSON 里化成 null）排最后。

// bmpPrivateUse 是 U+E000：UTF-16 码元 0xE000。U+10000 是代理对 D800 DC00，
// 码元序上排在 U+E000 之前；按码点或 UTF-8 字节排序会得到相反顺序。
const bmpPrivateUse = "\uE000"
const supplementary = "\U00010000"

func TestSortModelIDsUsesUTF16CodeUnitOrder(t *testing.T) {
	ids := []modelID{
		{value: "A", defined: true},
		{value: bmpPrivateUse, defined: true},
		{value: supplementary, defined: true},
		{value: "a", defined: true},
		{value: "10", defined: true},
		{value: "9", defined: true},
	}
	got := make([]string, 0, len(ids))
	for _, id := range sortModelIDs(ids) {
		got = append(got, id.value.(string))
	}
	want := []string{"10", "9", "A", "a", supplementary, bmpPrivateUse}
	if len(got) != len(want) {
		t.Fatalf("sorted = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sorted = %q, want %q", got, want)
		}
	}
}

func TestSortModelIDsPutsUndefinedLast(t *testing.T) {
	ids := []modelID{
		{defined: false},
		{value: "b", defined: true},
		{defined: false},
		{value: "a", defined: true},
	}
	sorted := sortModelIDs(ids)
	if sorted[0].value != "a" || sorted[1].value != "b" {
		t.Fatalf("sorted = %+v", sorted)
	}
	if sorted[2].defined || sorted[3].defined {
		t.Fatalf("undefined ids must sort last: %+v", sorted)
	}
}

func TestJSStringValue(t *testing.T) {
	cases := []struct {
		value any
		want  string
	}{
		{nil, "null"},
		{"x", "x"},
		{true, "true"},
		{false, "false"},
		{float64(0), "0"},
		{float64(1.5), "1.5"},
		{[]any{float64(1), "a"}, "1,a"},
		{map[string]any{}, "[object Object]"},
	}
	for _, tc := range cases {
		if got := jsStringValue(tc.value); got != tc.want {
			t.Fatalf("jsStringValue(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}
