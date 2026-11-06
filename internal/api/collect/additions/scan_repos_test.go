package additions_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// buildRepoTree 建一棵扫描夹具树，返回根目录。根在 /tmp 下（白名单内）。
//
// 形状覆盖 actions.ts 的扫描语义：
//   - 根自身带 .git（容器永远不算结果，只下钻子目录）；
//   - alpha 是深度 1 的仓库；
//   - group/beta 是深度 2 的仓库，beta/nested 不应单独出现（命中仓库即停止下钻）；
//   - deep/one/two 是深度 3 的仓库（默认 maxDepth=3 的边缘）；
//   - .hidden/secret 在隐藏目录下（整棵跳过）；
//   - worktree-repo 的 .git 是文件（worktree/submodule 形态也计入）。
func buildRepoTree(t *testing.T) string {
	t.Helper()

	root := t.TempDir()
	mkdir(t, filepath.Join(root, ".git"))
	mkdir(t, filepath.Join(root, "alpha", ".git"))
	mkdir(t, filepath.Join(root, "group", "beta", ".git"))
	mkdir(t, filepath.Join(root, "group", "beta", "nested", ".git"))
	mkdir(t, filepath.Join(root, "deep", "one", "two", ".git"))
	mkdir(t, filepath.Join(root, ".hidden", "secret", ".git"))

	worktree := filepath.Join(root, "worktree-repo")
	mkdir(t, worktree)
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: /nowhere\n"), 0o600); err != nil {
		t.Fatalf("write worktree .git: %v", err)
	}
	return root
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

// jsonString 用 JSON 字符串字面量嵌入路径（路径里可能有反斜杠等字符）。
func jsonString(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func scanBody(basePath string) string {
	return `{"basePath":` + jsonString(basePath) + `}`
}

// repoPaths 抽出响应里的 path 列表并排序（Go 的 os.ReadDir 按文件名排序，
// Node 的 readdirSync 是目录项顺序；顺序不在契约内，断言按集合比较）。
func repoPaths(t *testing.T, body map[string]any) []string {
	t.Helper()

	raw, ok := body["repos"].([]any)
	if !ok {
		t.Fatalf("repos is not an array: %v", body["repos"])
	}
	paths := make([]string, 0, len(raw))
	for _, item := range raw {
		repo, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("repo element is not an object: %v", item)
		}
		path, ok := repo["path"].(string)
		if !ok {
			t.Fatalf("repo.path is not a string: %v", repo)
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func wantSorted(paths ...string) []string {
	sorted := append([]string(nil), paths...)
	sort.Strings(sorted)
	return sorted
}

func assertPathsEqual(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("repos = %v, want %v", got, want)
	}
}

// 成功路径：默认 maxDepth=3，容器不下钻自身，隐藏目录跳过，.git 为文件也计入。
func TestScanReposFindsRepositoriesUnderTheRequestedContainer(t *testing.T) {
	h := newHarness(t)
	root := buildRepoTree(t)

	rec := h.post("/api/collect/scan-repos", scanBody(root))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	body := decodeBody(t, rec)
	if value, ok := body["error"]; ok {
		t.Fatalf("unexpected error field: %v", value)
	}

	assertPathsEqual(t, repoPaths(t, body), wantSorted(
		filepath.Join(root, "alpha"),
		filepath.Join(root, "deep", "one", "two"),
		filepath.Join(root, "group", "beta"),
		filepath.Join(root, "worktree-repo"),
	))
}

// 扫描深度：maxDepth 是 depth > maxDepth 才停（actions.ts 的 `>` 语义），
// 不是常见的 `>=`。
func TestScanReposHonoursMaxDepth(t *testing.T) {
	h := newHarness(t)
	root := buildRepoTree(t)

	cases := []struct {
		name     string
		maxDepth string
		want     []string
	}{
		{
			name:     "depth 1",
			maxDepth: `1`,
			want:     wantSorted(filepath.Join(root, "alpha"), filepath.Join(root, "worktree-repo")),
		},
		{
			name:     "depth 2",
			maxDepth: `2`,
			want:     wantSorted(filepath.Join(root, "alpha"), filepath.Join(root, "group", "beta"), filepath.Join(root, "worktree-repo")),
		},
		{
			name:     "depth 3",
			maxDepth: `3`,
			want: wantSorted(
				filepath.Join(root, "alpha"),
				filepath.Join(root, "deep", "one", "two"),
				filepath.Join(root, "group", "beta"),
				filepath.Join(root, "worktree-repo"),
			),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.post("/api/collect/scan-repos", `{"basePath":`+jsonString(root)+`,"maxDepth":`+tc.maxDepth+`}`)
			if rec.Code != 200 {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			assertPathsEqual(t, repoPaths(t, decodeBody(t, rec)), tc.want)
		})
	}
}

// alreadyAdded 判定：只认 type='git-local' 的 config.owner；其它类型即使 owner
// 撞上也不影响。
func TestScanReposMarksAlreadyAddedGitLocalSources(t *testing.T) {
	h := newHarness(t)
	root := buildRepoTree(t)

	alpha := filepath.Join(root, "alpha")
	beta := filepath.Join(root, "group", "beta")
	h.seedSource("git-local", "alpha", fmt.Sprintf(`{"owner":%s,"authorEmails":[],"branches":[]}`, jsonString(alpha)))
	// 非 git-local：actions.ts 的查询带 eq(type,'git-local')，不应参与判定。
	h.seedSource("git-remote", "beta-remote", fmt.Sprintf(`{"owner":%s}`, jsonString(beta)))

	rec := h.post("/api/collect/scan-repos", scanBody(root))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	body := decodeBody(t, rec)
	raw, ok := body["repos"].([]any)
	if !ok {
		t.Fatalf("repos is not an array: %v", body["repos"])
	}

	added := map[string]bool{}
	names := map[string]string{}
	for _, item := range raw {
		repo := item.(map[string]any)
		path := repo["path"].(string)
		added[path] = repo["alreadyAdded"].(bool)
		names[path] = repo["name"].(string)
	}

	if !added[alpha] {
		t.Fatalf("alpha should be alreadyAdded=true: %v", added)
	}
	if added[beta] {
		t.Fatalf("git-remote source must not mark beta as alreadyAdded: %v", added)
	}
	if names[alpha] != "alpha" {
		t.Fatalf("name = %q, want basename %q", names[alpha], "alpha")
	}
	if names[beta] != "beta" {
		t.Fatalf("name = %q, want basename %q", names[beta], "beta")
	}
}

// 显式 maxDepth: null 不触发默认参数（JS 的默认参数只对 undefined 生效），
// `currentDepth > null` 折算为 `> 0`，所以连深度 1 的子目录都不下钻。
func TestScanReposTreatsNullMaxDepthAsZero(t *testing.T) {
	h := newHarness(t)
	root := buildRepoTree(t)

	rec := h.post("/api/collect/scan-repos", `{"basePath":`+jsonString(root)+`,"maxDepth":null}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	assertPathsEqual(t, repoPaths(t, decodeBody(t, rec)), []string{})
}

// 白名单：$HOME / /opt / /srv / /var / /tmp 之外一律拒绝，回 200 + 内嵌 error。
func TestScanReposRejectsPathsOutsideTheWhitelist(t *testing.T) {
	h := newHarness(t)

	rec := h.post("/api/collect/scan-repos", scanBody("/etc"))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	body := decodeBody(t, rec)
	if got := body["error"]; got != "不允许访问此目录" {
		t.Fatalf("error = %v, want 不允许访问此目录", got)
	}
	if repos, ok := body["repos"].([]any); !ok || len(repos) != 0 {
		t.Fatalf("repos = %v, want []", body["repos"])
	}
}

// $HOME 展开：`~` 走 expandInputPath 展开到 HOME，且 HOME 本身在白名单内。
func TestScanReposExpandsHomeShorthand(t *testing.T) {
	h := newHarness(t)
	home := os.Getenv("HOME")
	repo := filepath.Join(home, "work", "one")
	mkdir(t, filepath.Join(repo, ".git"))

	rec := h.post("/api/collect/scan-repos", scanBody("~"))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	assertPathsEqual(t, repoPaths(t, decodeBody(t, rec)), wantSorted(repo))
}

// 顶层路径本身就是仓库时，结果为空（容器语义），与 src/app/collect/actions.test.ts
// 的同名用例一致。
//
// 该 vitest 文件保留到 B8 cutover：ticket #118 未把它列入随票删除清单（票面写的是
// 「新路由无 TS 前身测试」），而 blueprint §7 的 cutover 清单会把
// src/app/collect/actions.ts 与「TS server 测试」一并删除。两条用例在 cutover 前
// 并存是显式决定，不是遗漏。
func TestScanReposDoesNotReturnTheContainerItself(t *testing.T) {
	h := newHarness(t)
	root := buildRepoTree(t)

	rec := h.post("/api/collect/scan-repos", scanBody(filepath.Join(root, "alpha")))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	assertPathsEqual(t, repoPaths(t, decodeBody(t, rec)), []string{})
}

func TestScanReposReportsMissingDirectories(t *testing.T) {
	h := newHarness(t)
	missing := filepath.Join(t.TempDir(), "missing")

	rec := h.post("/api/collect/scan-repos", scanBody(missing))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	body := decodeBody(t, rec)
	if got := body["error"]; got != "目录不存在" {
		t.Fatalf("error = %v, want 目录不存在", got)
	}
	if repos, ok := body["repos"].([]any); !ok || len(repos) != 0 {
		t.Fatalf("repos = %v, want []", body["repos"])
	}
}

// 请求体不可解析也走 actions.ts 的 catch 语义：200 + 内嵌 error，
// HTTP 层错误只来自 withAuth/audit（票面 / ADR-0030）。
func TestScanReposKeepsTheErrorInsideTheBusinessObject(t *testing.T) {
	h := newHarness(t)

	rec := h.post("/api/collect/scan-repos", `{"basePath":`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if message, ok := body["error"].(string); !ok || message == "" {
		t.Fatalf("error = %v, want a non-empty string", body["error"])
	}
	if repos, ok := body["repos"].([]any); !ok || len(repos) != 0 {
		t.Fatalf("repos = %v, want []", body["repos"])
	}
}

// 读库失败同样落在 catch 分支。
func TestScanReposReportsStorageErrors(t *testing.T) {
	h := newHarness(t)
	root := buildRepoTree(t)
	h.breakDB()

	rec := h.post("/api/collect/scan-repos", scanBody(root))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if message, ok := body["error"].(string); !ok || message == "" {
		t.Fatalf("error = %v, want a non-empty string", body["error"])
	}
	if repos, ok := body["repos"].([]any); !ok || len(repos) != 0 {
		t.Fatalf("repos = %v, want []", body["repos"])
	}
}
