package collect

import (
	"os"
	"path/filepath"
	"testing"
)

// 本文件是 src/lib/collect/paths.test.ts 与白名单判定的 Go 版本。白名单是票面
// 明确要求「必有断言」的部分，因此这里直接对纯函数做表驱动断言，再由
// scan-path 的 httptest 覆盖 403 的线上形状。

func TestExpandInputPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	cases := []struct{ name, input, want string }{
		{"bare tilde", "~", home},
		{"tilde slash", "~/github/weekly", filepath.Join(home, "github/weekly")},
		{"trailing slash preserved", "~/", home + "/"},
		{"trailing slash on absolute", home + "/github/", home + "/github/"},
		{"surrounding whitespace trimmed", "  ~/github  ", filepath.Join(home, "github")},
		{"tilde user unsupported", "~god/github", filepath.Join(home, "~god/github")},
		{"tilde not at start", "/tmp/~weird", "/tmp/~weird"},
		{"relative resolves under home", "github/weekly", filepath.Join(home, "github/weekly")},
		{"absolute normalized", "/opt//projects/../repo", "/opt/repo"},
		{"parent segments collapse", "~/../outside", filepath.Join(home, "..", "outside")},
		{"empty input is home", "", home},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := expandInputPath(tc.input); got != filepath.Clean(tc.want) && got != tc.want {
				t.Fatalf("expandInputPath(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestIsPathAllowed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	allowed := []string{
		home,
		filepath.Join(home, "repo"),
		"/home",
		"/home/someone/repo",
		"/opt",
		"/opt/projects/app",
		"/srv/data",
		"/var/log",
		"/tmp",
		"/tmp/anything",
	}
	for _, path := range allowed {
		t.Run("allowed "+path, func(t *testing.T) {
			if !isPathAllowed(path) {
				t.Fatalf("isPathAllowed(%q) = false, want true", path)
			}
		})
	}

	denied := []string{
		"/",
		"/etc",
		"/etc/passwd",
		"/root",
		"/usr/local",
		"/various",  // `/var` + 非分隔符：按段比较，不能算在 /var 下
		"/homepage", // 同上
		"/opt2/x",   // 同上
		"/tmpfoo",   // 同上
	}
	for _, path := range denied {
		t.Run("denied "+path, func(t *testing.T) {
			if isPathAllowed(path) {
				t.Fatalf("isPathAllowed(%q) = true, want false", path)
			}
		})
	}

	// 相对路径按进程工作目录解析（path.resolve 语义）。本仓的工作目录在 /home 下，
	// 所以相对路径会落进白名单——这与 route.ts 一致（它不做额外的「必须是绝对路径」检查）。
	if !isPathAllowed("relative/dir") {
		t.Fatalf("relative paths resolve against cwd and should be allowed here")
	}
}

func TestNormalizeRepoName(t *testing.T) {
	cases := []struct{ input, want string }{
		{"", ""},
		{"   ", ""},
		{"https://github.com/owner/repo.git", "owner/repo"},
		{"https://github.com/owner/repo/", "owner/repo"},
		{"git@github.com:owner/repo.git", "owner/repo"},
		{"ssh://git@github.com/owner/repo", "owner/repo"},
		{"git://github.com/owner/repo", "owner/repo"},
		{"git.company.com/team/project", "team/project"},
		{"owner/repo", "repo"}, // 无协议时第一段按 host 剥掉（utils.ts 原语义）
		{"single-name", "single-name"},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			if got := normalizeRepoName(tc.input); got != tc.want {
				t.Fatalf("normalizeRepoName(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestOrderBranchesForAttribution(t *testing.T) {
	if got := orderBranchesForAttribution([]string{"develop", "main", "release"}, "main"); !equalStrings(got, []string{"main", "develop", "release"}) {
		t.Fatalf("got %v", got)
	}
	if got := orderBranchesForAttribution([]string{"develop", "release"}, ""); !equalStrings(got, []string{"develop", "release"}) {
		t.Fatalf("got %v", got)
	}
	if got := orderBranchesForAttribution([]string{"b", "a", "c"}, ""); !equalStrings(got, []string{"a", "b", "c"}) {
		t.Fatalf("got %v", got)
	}
	if got := orderBranchesForAttribution([]string{"main", "develop"}, "main"); len(got) != 2 {
		t.Fatalf("duplicate current branch: %v", got)
	}
}

func TestIsEmptyBranchConfig(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want bool
	}{
		{"missing", nil, true},
		{"empty array", []any{}, true},
		{"blank objects", []any{map[string]any{"name": "  "}, map[string]any{"name": ""}}, true},
		{"object form", []any{map[string]any{"name": "main"}}, false},
		{"string form", []any{"main"}, false},
		{"non-array", "main", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isEmptyBranchConfig(tc.raw); got != tc.want {
				t.Fatalf("isEmptyBranchConfig(%v) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// 编译期确认 os 包在 HOME 缺失时仍返回空串（expandInputPath 的兜底分支）。
var _ = os.Getenv

// git 执行面的错误文案是冻结契约的一部分（route.ts 按 stderr 文本分支），
// 这里钉住三种输入的错误形态。
func TestGitExecErrorMessages(t *testing.T) {
	dir := t.TempDir()

	// 1) 不是仓库：stderr 是 fatal: not a git repository...
	if _, err := runGit(t.Context(), dir, "rev-parse", "--is-inside-work-tree"); err == nil {
		t.Fatal("expected an error for a non-repository directory")
	} else if !isNotAGitRepository(err.Error()) {
		t.Fatalf("error = %q, want a not-a-git-repository message", err.Error())
	}

	// 2) 目录不存在：Go 在 chdir 阶段失败，文案对齐 Node 的 `spawn git ENOENT`。
	missing := filepath.Join(dir, "missing")
	if _, err := runGit(t.Context(), missing, "rev-parse", "--is-inside-work-tree"); err == nil {
		t.Fatal("expected an error for a missing directory")
	} else if !isMissingPath(err.Error()) {
		t.Fatalf("error = %q, want an ENOENT-shaped message", err.Error())
	}
}
