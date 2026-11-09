package sources_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件覆盖 branches 路由。该路由没有 vitest（票面要求：httptest 补 happy path +
// `{error, code}` 错误形状；本路由所有业务失败都回 200 + `{branches: []}`，
// HTTP 层错误只来自鉴权）。

type branchesResponse struct {
	Branches      []string `json:"branches"`
	CurrentBranch string   `json:"currentBranch"`
}

// TestBranchesLocalGitHappyPath 覆盖本地仓库 happy path：
// 去 origin/ 前缀、按首次出现去重、默认 sort() 升序，currentBranch 是当前分支。
func TestBranchesLocalGitHappyPath(t *testing.T) {
	h := newHarness(t)
	repo := initGitRepo(t)
	commitAs(t, repo, "Dev", "dev@example.com", "init")
	createBranch(t, repo, "feature-b")
	createBranch(t, repo, "feature-a")

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/branches?type=git-local&path="+queryEscape(repo), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload branchesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []string{"feature-a", "feature-b", "main"}
	if len(payload.Branches) != len(want) {
		t.Fatalf("branches = %v, want %v", payload.Branches, want)
	}
	for i := range want {
		if payload.Branches[i] != want[i] {
			t.Fatalf("branches = %v, want %v", payload.Branches, want)
		}
	}
	if payload.CurrentBranch != "main" {
		t.Fatalf("currentBranch = %q", payload.CurrentBranch)
	}
}

// TestBranchesInvalidPathReturnsEmpty 覆盖本地 git 命令失败 → 空列表 + 空当前分支。
func TestBranchesInvalidPathReturnsEmpty(t *testing.T) {
	h := newHarness(t)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/branches?type=git-local&path=/nonexistent-repo-path-test", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var payload branchesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Branches) != 0 || payload.CurrentBranch != "" {
		t.Fatalf("payload = %+v", payload)
	}
}

// TestBranchesRemoteUsesStoredToken 覆盖 sourceId → 存量 token 回退（编辑表单）。
func TestBranchesRemoteUsesStoredToken(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-remote-github", "remote", `{"owner":"org","repo":"repo","token":"stored-token","authorEmails":["a@b.c"]}`)
	h.stubProvider(http.StatusOK, `[{"name":"main"},{"name":"dev"}]`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/branches?type=git-remote-github&owner=org&repo=repo&sourceId=1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload branchesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Branches) != 2 || payload.Branches[0] != "dev" || payload.Branches[1] != "main" {
		t.Fatalf("branches = %v", payload.Branches)
	}
	if len(h.requests) != 1 {
		t.Fatalf("provider calls = %d", len(h.requests))
	}
	if got := h.requests[0].Header.Get("Authorization"); got != "Bearer stored-token" {
		t.Fatalf("Authorization = %q", got)
	}
}

// TestBranchesRemoteProviderFailureReturnsEmpty 覆盖远端非 2xx → `{branches: []}`。
func TestBranchesRemoteProviderFailureReturnsEmpty(t *testing.T) {
	h := newHarness(t)
	h.stubProvider(http.StatusForbidden, `{}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/branches?type=git-remote-github&owner=org&repo=repo&token=t", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var payload branchesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Branches) != 0 {
		t.Fatalf("branches = %v", payload.Branches)
	}
}

// TestBranchesRequiresAuth 确认路由挂在鉴权链之后（HTTP 层错误只来自 withAuth）。
func TestBranchesRequiresAuth(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/collect/sources/branches", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
