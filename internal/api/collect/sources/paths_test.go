package sources

import (
	"testing"
)

// TestExpandInputPathMatchesNode 的期望值来自在施工机上跑 Node path.resolve 的
// 同一组输入（见 src/lib/collect/paths.ts 的语义）。
func TestExpandInputPathMatchesNode(t *testing.T) {
	t.Setenv("HOME", "/home/tester")

	cases := []struct{ input, want string }{
		{"~/repo/", "/home/tester/repo/"},
		{"~/", "/home/tester/"},
		{"~", "/home/tester"},
		{"/abs/", "/abs/"},
		{"/abs", "/abs"},
		{"rel", "/home/tester/rel"},
		{"./rel", "/home/tester/rel"},
		{"../up", "/home/up"},
		{"/", "/"},
		{"//", "/"},
		{"///a//b//", "/a/b/"},
		{"~/a//b//", "/home/tester/a/b/"},
		{"  ~/repo  ", "/home/tester/repo"},
		{"a/", "/home/tester/a/"},
	}
	for _, tc := range cases {
		if got := expandInputPath(tc.input); got != tc.want {
			t.Errorf("expandInputPath(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

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
