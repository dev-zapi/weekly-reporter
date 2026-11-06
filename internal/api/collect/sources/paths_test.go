package sources

import (
	"testing"
)

// TestStripTrailingSlashPreservesRoot 复刻 `p.replace(/(.)\/+$/, '$1')`。
func TestStripTrailingSlashPreservesRoot(t *testing.T) {
	cases := []struct{ input, want string }{
		{"/home/tester/repo//", "/home/tester/repo"},
		{"/", "/"},
		{"//", "/"},
		{"abc", "abc"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := stripTrailingSlash(tc.input); got != tc.want {
			t.Errorf("stripTrailingSlash(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// TestMaskTokenKeepsObjectOrder 复刻 `{...config, token}`：已存在的 token 原位
// 覆盖，否则追加到末尾。
func TestMaskTokenKeepsObjectOrder(t *testing.T) {
	cases := []struct{ input, want string }{
		{`{"owner":"/a","token":"secret"}`, `{"owner":"/a","token":"[ENCRYPTED]"}`},
		{`{"owner":"/a"}`, `{"owner":"/a","token":"[ENCRYPTED]"}`},
		{`{}`, `{"token":"[ENCRYPTED]"}`},
		{`null`, `{"token":"[ENCRYPTED]"}`},
		{`[1,2]`, `{"0":1,"1":2,"token":"[ENCRYPTED]"}`},
	}
	for _, tc := range cases {
		got, err := maskToken([]byte(tc.input))
		if err != nil {
			t.Fatalf("maskToken(%s): %v", tc.input, err)
		}
		if string(got) != tc.want {
			t.Errorf("maskToken(%s) = %s, want %s", tc.input, got, tc.want)
		}
	}

	if _, err := maskToken([]byte("not json")); err == nil {
		t.Fatal("invalid JSON must fail like JSON.parse")
	}
}

// TestJSSortStringsOrdersByUTF16CodeUnit 复刻 `Array.prototype.sort()` 的默认比较：
// 增补平面字符（UTF-16 代理对 0xD800..0xDFFF）排在 U+E000..U+FFFF 之后，而不是按码点。
func TestJSSortStringsOrdersByUTF16CodeUnit(t *testing.T) {
	values := []string{"\uE000", "\U0001F600", "a", "B"}
	jsSortStrings(values)
	// Node 侧 ['\uE000','\U0001F600','a','B'].sort() = ['B','a','\U0001F600','\uE000']：
	// 代理对首元 0xD83D 小于 0xE000。
	want := []string{"B", "a", "\U0001F600", "\uE000"}
	for i := range want {
		if values[i] != want[i] {
			t.Fatalf("sorted = %q, want %q", values, want)
		}
	}
}

// TestParseJSIntDouble 复刻 parseInt 的形态：跳过前导空白、容忍尾随垃圾、识别
// 0x 前缀、空/非数字是 NaN。
func TestParseJSIntDouble(t *testing.T) {
	cases := []struct {
		input string
		want  float64
		ok    bool
	}{
		{"12abc", 12, true},
		{"  7", 7, true},
		{"-3", -3, true},
		{"0x10", 16, true},
		{"", 0, false},
		{"abc", 0, false},
		{"5.9", 5, true},
	}
	for _, tc := range cases {
		got, ok := parseJSIntDouble(tc.input)
		if ok != tc.ok || (tc.ok && got != tc.want) {
			t.Errorf("parseJSIntDouble(%q) = %v/%v, want %v/%v", tc.input, got, ok, tc.want, tc.ok)
		}
	}
}

// TestNumberFromQueryMatchesNumber 复刻 `Number(s)` + Number.isInteger。
func TestNumberFromQueryMatchesNumber(t *testing.T) {
	cases := []struct {
		input     string
		want      float64
		wantIsInt bool
	}{
		{"7", 7, true},
		{"", 0, true},
		{"7.5", 7.5, false},
		{"abc", 0, false},
		{"0x10", 16, true},
		{" 3 ", 3, true},
	}
	for _, tc := range cases {
		got, isInt := numberFromQuery(tc.input)
		if isInt != tc.wantIsInt || (tc.wantIsInt && got != tc.want) {
			t.Errorf("numberFromQuery(%q) = %v/%v, want %v/%v", tc.input, got, isInt, tc.want, tc.wantIsInt)
		}
	}
}
