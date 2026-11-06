package additions

import (
	"strings"
	"testing"
)

// 白名单必须有断言（票面要求）：逐条覆盖 actions.ts 的 ALLOWED_BASE_DIRS。
func TestIsPathAllowedCoversTheActionsWhitelist(t *testing.T) {
	t.Setenv("HOME", "/home/tester")

	cases := []struct {
		path string
		want bool
	}{
		{"/home/tester", true},
		{"/home/tester/repo", true},
		{"/opt/app", true},
		{"/srv/data", true},
		{"/var/lib/weekly-reporter", true},
		{"/tmp/ws", true},
		// actions.ts 用的是裸 strings.startsWith（scan-path route 才是
		// `=== base || startsWith(base + '/')`）。票面要求照抄，故前缀撞上即放行。
		{"/opt-sibling", true},
		{"/etc", false},
		{"/home/other", false},
		{"/root", false},
		{"/", false},
	}

	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			if got := isPathAllowed(tc.path); got != tc.want {
				t.Fatalf("isPathAllowed(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

// HOME 缺省时回落 '/home'（actions.ts: `process.env.HOME || '/home'`）。
func TestAllowedBaseDirsFallBackToHome(t *testing.T) {
	t.Setenv("HOME", "")

	dirs := allowedBaseDirs()
	want := []string{"/home", "/opt", "/srv", "/var", "/tmp"}
	if strings.Join(dirs, ",") != strings.Join(want, ",") {
		t.Fatalf("allowedBaseDirs() = %v, want %v", dirs, want)
	}
}
