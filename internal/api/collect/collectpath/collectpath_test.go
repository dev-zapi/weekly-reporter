package collectpath

import (
	"path/filepath"
	"strings"
	"testing"
)

// 本文件的展开向量来自 src/lib/collect/paths.test.ts 与施工机上 Node
// path.resolve 的实测结果；B4 三张票原先各自在自己的包内断言同一批输入，
// 收口后只保留这一份。
func TestExpandInputPathMatchesNode(t *testing.T) {
	t.Setenv("HOME", "/home/tester")

	cases := []struct{ input, want string }{
		{"~", "/home/tester"},
		{"~/", "/home/tester/"},
		{"~/repo/", "/home/tester/repo/"},
		{"~/a//b//", "/home/tester/a/b/"},
		{"/abs", "/abs"},
		{"/abs/", "/abs/"},
		{"rel", "/home/tester/rel"},
		{"./rel", "/home/tester/rel"},
		{"a/", "/home/tester/a/"},
		{"../up", "/home/up"},
		{"/", "/"},
		{"//", "/"},
		{"///a//b//", "/a/b/"},
		{"  ~/repo  ", "/home/tester/repo"},
		{"~god/github", "/home/tester/~god/github"}, // ~user 不展开
		{"/tmp/~weird", "/tmp/~weird"},              // ~ 不在开头不展开
		{"/opt//projects/../repo", "/opt/repo"},
		{"~/../outside", "/home/outside"},
		{"", "/home/tester"},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			if got := ExpandInputPath(tc.input); got != tc.want {
				t.Fatalf("ExpandInputPath(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// HOME 缺省时回落 '/home'（`process.env.HOME || '/home'`）。
func TestExpandInputPathFallsBackToHome(t *testing.T) {
	t.Setenv("HOME", "")
	if got := ExpandInputPath("~"); got != "/home" {
		t.Fatalf("ExpandInputPath(\"~\") = %q, want /home", got)
	}
}

// Resolve 复刻 Node path.resolve：绝对段覆盖前面的段，无绝对段时以 cwd 为基准。
func TestResolveMatchesNode(t *testing.T) {
	cwd, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	cases := []struct {
		parts []string
		want  string
	}{
		{[]string{"/a", "b"}, "/a/b"},
		{[]string{"/a", "/b"}, "/b"},
		{[]string{"a", "/b", "c"}, "/b/c"},
		{[]string{"/a//b", "..", "c"}, "/a/c"},
		{[]string{"rel"}, filepath.Join(cwd, "rel")},
	}
	for _, tc := range cases {
		if got := Resolve(tc.parts...); got != tc.want {
			t.Fatalf("Resolve(%q) = %q, want %q", tc.parts, got, tc.want)
		}
	}
}

func TestStandardBaseDirs(t *testing.T) {
	want := "/opt,/srv,/var,/tmp"
	if got := strings.Join(StandardBaseDirs, ","); got != want {
		t.Fatalf("StandardBaseDirs = %s, want %s", got, want)
	}
}
