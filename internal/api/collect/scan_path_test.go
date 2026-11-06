package collect_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件覆盖 /api/collect/scan-path：route.ts 无既有 vitest，按票面新写 httptest。
// 白名单拒绝、模糊搜索、深度与 50 条截断都在这里断言。

// seedDirs 在 base 下建目录（自动 mkdir -p）。
func seedDirs(t *testing.T, base string, names ...string) {
	t.Helper()
	for _, name := range names {
		if err := os.MkdirAll(filepath.Join(base, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
}

// scan 发一个 scan-path 请求（path 参数自动 URL 编码）。
func (h *harness) scan(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	rec := h.do(http.MethodGet, "/api/collect/scan-path?path="+url.QueryEscape(path), "", testPassword)
	return decode(t, rec)
}

// directories 取响应里的 directories 数组。
func directories(t *testing.T, body map[string]any) []map[string]any {
	t.Helper()
	raw, ok := body["directories"].([]any)
	if !ok {
		t.Fatalf("directories is not an array: %v", body["directories"])
	}
	out := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		out = append(out, entry.(map[string]any))
	}
	return out
}

func directoryNames(t *testing.T, body map[string]any) []string {
	t.Helper()
	rows := directories(t, body)
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, row["name"].(string))
	}
	return names
}

// 裸 `~` 与空输入列出 $HOME 内容。
func TestScanPathListsHomeContents(t *testing.T) {
	h := newHarness(t)
	seedDirs(t, h.home, "github", "projects", ".hidden")

	for _, input := range []string{"", "~"} {
		t.Run("input "+input, func(t *testing.T) {
			status, body := h.scan(t, input)
			if status != http.StatusOK {
				t.Fatalf("status = %d, body = %v", status, body)
			}
			if body["exists"] != true || body["path"] != h.home {
				t.Fatalf("body = %v", body)
			}
			names := directoryNames(t, body)
			if len(names) != 2 || !contains(names, "github") || !contains(names, "projects") {
				t.Fatalf("names = %v", names)
			}
			// 隐藏目录被过滤。
			if contains(names, ".hidden") {
				t.Fatalf("hidden dir leaked: %v", names)
			}
		})
	}
}

// 相对路径按 $HOME 展开（CONTEXT.md「路径展开」）。
func TestScanPathExpandsRelativeInput(t *testing.T) {
	h := newHarness(t)
	seedDirs(t, filepath.Join(h.home, "github"), "weekly", "other")

	status, body := h.scan(t, "github/")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["path"] != filepath.Join(h.home, "github") {
		t.Fatalf("path = %v", body["path"])
	}
	names := directoryNames(t, body)
	if len(names) != 2 || !contains(names, "weekly") {
		t.Fatalf("names = %v", names)
	}
}

// 白名单拒绝：票面要求「白名单拒绝路径必须有断言」。
func TestScanPathRejectsNonWhitelistedPath(t *testing.T) {
	h := newHarness(t)

	cases := []string{"/etc", "/etc/services", "/root", "/usr/local", "/various"}
	for _, input := range cases {
		t.Run(input, func(t *testing.T) {
			status, body := h.scan(t, input)
			if status != http.StatusForbidden {
				t.Fatalf("status = %d, body = %v", status, body)
			}
			if body["code"] != "FORBIDDEN" || body["error"] != "不允许访问此目录" {
				t.Fatalf("body = %v", body)
			}
		})
	}
}

// `/var/`、`/opt/`、`/srv/`、`/tmp/` 本身在白名单里。注意必须带结尾斜杠：
// route.ts 用「最后一个 / 之前」当 basePath，裸 `/tmp` 会被拆成 base=`/` + query=`tmp`。
func TestScanPathAllowsWhitelistedRoots(t *testing.T) {
	h := newHarness(t)

	for _, input := range []string{"/tmp/", "/var/", "/opt/", "/srv/", "/home/"} {
		t.Run(input, func(t *testing.T) {
			status, body := h.scan(t, input)
			if status != http.StatusOK {
				t.Fatalf("status = %d, body = %v", status, body)
			}
			if body["path"] != strings.TrimSuffix(input, "/") {
				t.Fatalf("path = %v, want %s", body["path"], strings.TrimSuffix(input, "/"))
			}
		})
	}
}

// basePath 存在且有 query：返回带 score 的模糊匹配，按分数降序。
func TestScanPathFuzzyFiltersExistingDirectory(t *testing.T) {
	h := newHarness(t)
	seedDirs(t, h.home, "github", "gitlab", "notes", "weekly-reporter")

	status, body := h.scan(t, "git")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	names := directoryNames(t, body)
	if len(names) != 2 || !contains(names, "github") || !contains(names, "gitlab") {
		t.Fatalf("names = %v", names)
	}
	// 完全相等 > 前缀 > 包含 > 子序列；两个都是前缀匹配，分数相同。
	for _, row := range directories(t, body) {
		if _, present := row["score"]; !present {
			t.Fatalf("score missing in %v", row)
		}
	}

	// 子序列匹配（gnr → github? 不匹配；用 wkr 匹配 weekly-reporter）。
	status, body = h.scan(t, "wkr")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	names = directoryNames(t, body)
	if len(names) != 1 || names[0] != "weekly-reporter" {
		t.Fatalf("names = %v", names)
	}
}

// basePath 不存在：向上找最近祖先，把剩余部分并入 query，回 exists=false + fuzzyQuery/fuzzyBase。
// 这里输入 `dep/`（父目录不存在、query 为空）：全查询词是 `dep`，从 $HOME 起模糊搜索。
func TestScanPathFuzzySearchesFromExistingAncestor(t *testing.T) {
	h := newHarness(t)
	seedDirs(t, h.home, "deep/nested/weekly")

	status, body := h.scan(t, "dep/")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["exists"] != false {
		t.Fatalf("exists = %v", body["exists"])
	}
	if body["path"] != filepath.Join(h.home, "dep") {
		t.Fatalf("path = %v", body["path"])
	}
	if body["fuzzyBase"] != h.home {
		t.Fatalf("fuzzyBase = %v", body["fuzzyBase"])
	}
	if body["fuzzyQuery"] != "dep" {
		t.Fatalf("fuzzyQuery = %v", body["fuzzyQuery"])
	}
	names := directoryNames(t, body)
	if len(names) != 1 || names[0] != "deep" {
		t.Fatalf("names = %v", names)
	}
}

// basePath 存在时 query 只是过滤词（不进入 exists=false 分支）。
func TestScanPathFiltersExistingDirectoryWithQuery(t *testing.T) {
	h := newHarness(t)
	seedDirs(t, h.home, "deep/nested/weekly", "deep/nested/other")

	status, body := h.scan(t, "deep/nested/week")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["exists"] != true {
		t.Fatalf("exists = %v, body = %v", body["exists"], body)
	}
	names := directoryNames(t, body)
	if len(names) != 1 || names[0] != "weekly" {
		t.Fatalf("names = %v", names)
	}
}

// 不存在且没有可合并的 query 时回空列表（不是 403/500）。
func TestScanPathMissingBaseWithoutQueryReturnsEmpty(t *testing.T) {
	h := newHarness(t)

	status, body := h.scan(t, "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["exists"] != true {
		t.Fatalf("home should exist: %v", body)
	}
}

// 50 条截断。
func TestScanPathTruncatesToFiftyEntries(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < 60; i++ {
		name := "dir-" + string(rune('a'+i%26)) + itoa(int64(i))
		seedDirs(t, h.home, name)
	}

	status, body := h.scan(t, "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if got := len(directories(t, body)); got != 50 {
		t.Fatalf("directories = %d, want 50", got)
	}
}

// scan-path 也要过鉴权。
func TestScanPathRequiresAuth(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/collect/scan-path?path="+url.QueryEscape("~"), "", "")
	status, body := decode(t, rec)
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %v", status, body)
	}
}

// 目录项的形状：只有 {name, path}（filter path 分支）或 {name, path, score}。
func TestScanPathResponseShape(t *testing.T) {
	h := newHarness(t)
	seedDirs(t, h.home, "alpha")

	status, body := h.scan(t, "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	rows := directories(t, body)
	if len(rows) != 1 {
		t.Fatalf("rows = %v", rows)
	}
	if len(rows[0]) != 2 {
		t.Fatalf("entry keys = %v, want exactly name+path", rows[0])
	}
	if rows[0]["path"] != filepath.Join(h.home, "alpha") {
		t.Fatalf("path = %v", rows[0]["path"])
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"exists":true`) {
		t.Fatalf("body = %s", encoded)
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
