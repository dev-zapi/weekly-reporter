package settings

import "testing"

// 本文件的期望值全部由 Node 24 实测得到（`new URL(v)` 是否抛 TypeError）。
// isValidAPIURL 只镜像「通过 / 抛错」，不关心 normalization：route.ts 把原始
// 字符串写进 ai_config。ISSUE 票面把 `new URL(apiUrl)` 作为 400 的唯一判据。

func TestValidAPIURLAccepts(t *testing.T) {
	cases := []string{
		"https://api.example.com/v1",
		"http://localhost:8080/v1/",
		"http://example.com",
		"https://例子.测试/路径",
		"http://user:pass@host",
		"http://x:0",
		"http://x:65535",
		"http://x:",
		"http://[::1]:80/x",
		"http://.",
		"http:example.com",
		"http:/example.com",
		"http:\\example.com",
		// WHATWG 解析前会 trim 首尾 C0/空格、删掉串内 tab/换行。
		" https://x.com ",
		"https://exa\tmple.com",
		"ht\ntp://x",
		// 非 special scheme：opaque 形态（没有 authority 解析）一律合法。
		"mailto:a@b",
		"foo:bar",
		"foo://h/p",
		"custom+scheme://h/p",
		"a:",
		"tel:+123",
		"data:text/plain,hi",
	}
	for _, input := range cases {
		if !isValidAPIURL(input) {
			t.Fatalf("isValidAPIURL(%q) = false, want true", input)
		}
	}
}

func TestValidAPIURLRejects(t *testing.T) {
	cases := []string{
		"",
		" ",
		"not-a-url",
		"foo",
		"/relative",
		"//host/path",
		"1http://x",
		"http://",
		"https://",
		"http:?q",
		"http:#f",
		"ftp://",
		"http://exa mple.com",
		"http://x^y",
		"http://x|y",
		"http://x:99999",
		"http://x:abc",
		"http://[::1",
		"http://[zz]",
		"http://[::1]x",
		"http://user@:80",
		"http://a%zz.com",
		"://",
		// 非 special scheme 带 authority 时 host 规则同样生效。
		"foo://x y",
	}
	for _, input := range cases {
		if isValidAPIURL(input) {
			t.Fatalf("isValidAPIURL(%q) = true, want false", input)
		}
	}
}

func TestTrimTrailingSlashesMatchesJSRRegex(t *testing.T) {
	cases := map[string]string{
		"https://x/v1///": "https://x/v1",
		"https://x/v1":    "https://x/v1",
		"///":             "",
		"":                "",
	}
	for input, want := range cases {
		if got := trimTrailingSlashes(input); got != want {
			t.Fatalf("trimTrailingSlashes(%q) = %q, want %q", input, got, want)
		}
	}
}
