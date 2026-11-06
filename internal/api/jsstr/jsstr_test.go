package jsstr

import "testing"

// 断言对照 Node 实测：`'一'.length === 1`、`'😀'.length === 2`、
// `'\u0085'.trim() === '\u0085'`（JS 的 \s 不含 NEL，而 Go 的 unicode.IsSpace 含）。

func TestUTF16Len(t *testing.T) {
	cases := []struct {
		input string
		want  int
	}{
		{"", 0},
		{"abc", 3},
		{"一二三", 3},          // BMP：每个汉字 1 个码元
		{"\U0001F600", 2},   // 增补平面：代理对
		{"a\U0001F600b", 4}, // 1 + 2 + 1
		{"ｱ", 1},            // 半角片假名在 BMP
	}
	for _, tc := range cases {
		if got := UTF16Len(tc.input); got != tc.want {
			t.Fatalf("UTF16Len(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
}

func TestTrimMatchesJSWhitespace(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"  abc  ", "abc"},
		{"\n\t#tag\r\n", "#tag"},
		{"\u00a0abc\u00a0", "abc"}, // NBSP 属于 \s
		{"\u3000abc\u3000", "abc"}, // IDEOGRAPHIC SPACE 属于 \s
		{"\ufeffabc\ufeff", "abc"}, // ZWNBSP 属于 \s
		{"\u2028abc\u2029", "abc"}, // 行分隔符 / 段分隔符
		{"\u2003abc\u2003", "abc"}, // EM SPACE
		{"abc", "abc"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := Trim(tc.input); got != tc.want {
			t.Fatalf("Trim(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// U+0085（NEL）在 Go 的 unicode.IsSpace 里是空白，但 ECMAScript 的 \s 不含它，
// 所以 Trim 必须保留它。这条是 IsSpace 表对齐的唯一可观测差别。
func TestTrimKeepsNEL(t *testing.T) {
	if got := Trim("\u0085abc"); got != "\u0085abc" {
		t.Fatalf("Trim kept %q, want NEL preserved", got)
	}
	if !IsSpace('\u3000') || !IsSpace('\u00a0') {
		t.Fatalf("IsSpace must accept Zs members")
	}
	if IsSpace('\u0085') {
		t.Fatalf("IsSpace must reject NEL (JS \\s does not include it)")
	}
}

// EncodeURIComponent 的期望值来自 Node：`encodeURIComponent('acme/widgets')` 是
// `acme%2Fwidgets`，保留字符集 `-_.!~*'()` 与字母数字不转义。
func TestEncodeURIComponentMatchesNode(t *testing.T) {
	cases := []struct{ input, want string }{
		{"acme/widgets", "acme%2Fwidgets"},
		{"a b", "a%20b"},
		{"-_.!~*'()", "-_.!~*'()"},
		{"AZaz09", "AZaz09"},
		{"中文", "%E4%B8%AD%E6%96%87"},
		{"a+b", "a%2Bb"},
		{"a%20b", "a%2520b"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := EncodeURIComponent(tc.input); got != tc.want {
			t.Fatalf("EncodeURIComponent(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}
