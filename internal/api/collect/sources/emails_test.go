package sources_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件是 src/app/api/collect/sources/emails/route.test.ts 的 Go 同用例集
// （ADR-0029）：3 条逐条对应，用打桩 fetch 替代 vitest 的 global.fetch mock。

type authorsResponse struct {
	Authors []struct {
		Email string `json:"email"`
		Name  string `json:"name"`
		Count int64  `json:"count"`
	} `json:"authors"`
}

// TestEmailsUsesStoredTokenWhenEditFormOmitsIt 对应 vitest 的第 1 条：
// sourceId 有效但表单没带 token 时，用库里的 token 打 provider。
func TestEmailsUsesStoredTokenWhenEditFormOmitsIt(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-remote-github", "remote", `{"owner":"org","repo":"repo","token":"stored-token","authorEmails":["a@b.c"]}`)
	h.stubProvider(http.StatusOK, `[{"author":{"email":"dev@example.com","login":"dev"},"commit":{"author":{"email":"dev@example.com","name":"Dev"}}}]`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/emails?type=git-remote-github&owner=org&repo=repo&sourceId=1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload authorsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Authors) != 1 || payload.Authors[0].Email != "dev@example.com" || payload.Authors[0].Name != "Dev" || payload.Authors[0].Count != 1 {
		t.Fatalf("authors = %+v", payload.Authors)
	}
	if len(h.requests) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(h.requests))
	}
	if got := h.requests[0].Header.Get("Authorization"); got != "Bearer stored-token" {
		t.Fatalf("Authorization = %q", got)
	}
}

// TestEmailsUsesFormTokenWithoutQueryingStoredToken 对应 vitest 的第 2 条：
// 表单带了 token 就直接用，不再查库（这里用「库里放另一个 token」断言取到的是表单值）。
func TestEmailsUsesFormTokenWithoutQueryingStoredToken(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-remote-github", "remote", `{"owner":"org","repo":"repo","token":"stored-token","authorEmails":["a@b.c"]}`)
	h.stubProvider(http.StatusOK, `[{"author":{"email":"dev@example.com","login":"dev"},"commit":{"author":{"email":"dev@example.com","name":"Dev"}}}]`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/emails?type=git-remote-github&owner=org&repo=repo&sourceId=1&token=form-token", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if len(h.requests) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(h.requests))
	}
	if got := h.requests[0].Header.Get("Authorization"); got != "Bearer form-token" {
		t.Fatalf("Authorization = %q", got)
	}
}

// TestEmailsReturnsEmptyWhenNoTokenAndNoSourceID 对应 vitest 的第 3 条：
// 没有 token 也没有可用 sourceId 时直接返回空列表，不发请求。
func TestEmailsReturnsEmptyWhenNoTokenAndNoSourceID(t *testing.T) {
	h := newHarness(t)
	h.stubProvider(http.StatusOK, `[]`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/emails?type=git-remote-github&owner=org&repo=repo", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload authorsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Authors) != 0 {
		t.Fatalf("authors = %+v", payload.Authors)
	}
	if len(h.requests) != 0 {
		t.Fatalf("provider calls = %d, want 0", len(h.requests))
	}
}

// TestEmailsLocalAuthorsAggregatesByCount 覆盖 git-local 分支（exec git，临时仓库）。
func TestEmailsLocalAuthorsAggregatesByCount(t *testing.T) {
	h := newHarness(t)
	repo := initGitRepo(t)
	commitAs(t, repo, "Dev One", "dev1@example.com", "first")
	commitAs(t, repo, "Dev One", "dev1@example.com", "second")
	commitAs(t, repo, "Dev Two", "dev2@example.com", "third")

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/emails?type=git-local&path="+queryEscape(repo), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload authorsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Authors) != 2 {
		t.Fatalf("authors = %+v", payload.Authors)
	}
	if payload.Authors[0].Email != "dev1@example.com" || payload.Authors[0].Count != 2 || payload.Authors[0].Name != "Dev One" {
		t.Fatalf("first author = %+v", payload.Authors[0])
	}
	if payload.Authors[1].Email != "dev2@example.com" || payload.Authors[1].Count != 1 {
		t.Fatalf("second author = %+v", payload.Authors[1])
	}
}

// TestEmailsProviderErrorReturnsEmpty 覆盖 provider 失败时的 `{authors: []}`。
func TestEmailsProviderErrorReturnsEmpty(t *testing.T) {
	h := newHarness(t)
	h.stubProvider(http.StatusUnauthorized, `{"message":"Bad credentials"}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/emails?type=git-remote-github&owner=org&repo=repo&token=t", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var payload authorsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Authors) != 0 {
		t.Fatalf("authors = %+v", payload.Authors)
	}
}
