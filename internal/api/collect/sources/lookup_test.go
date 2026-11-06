package sources_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// 本文件是 src/app/api/collect/sources/lookup/route.test.ts 的 Go 同用例集
// （ADR-0029）：13 条逐条对应。vitest mock 了 tryRealpath，这里改用真实临时目录与
// 符号链接（realpath 的真实语义），其余断言形状一致。

type lookupResponse struct {
	ID     int64           `json:"id"`
	Config json.RawMessage `json:"config"`
}

func TestLookupRejectsNonLocalType(t *testing.T) {
	h := newHarness(t)

	for name, query := range map[string]string{
		"wrong type": "type=git-remote-github&path=/x",
		"missing":    "path=/x",
	} {
		t.Run(name, func(t *testing.T) {
			rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?"+query, "")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_TYPE" {
				t.Fatalf("code = %q", code)
			}
		})
	}
}

func TestLookupRejectsMissingOrEmptyPath(t *testing.T) {
	h := newHarness(t)

	for name, query := range map[string]string{
		"missing": "type=git-local",
		"empty":   "type=git-local&path=",
	} {
		t.Run(name, func(t *testing.T) {
			rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?"+query, "")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_PATH" {
				t.Fatalf("code = %q", code)
			}
		})
	}
}

func TestLookupMatchesByExactString(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "repo", `{"owner":"/home/god/github/repo","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path=/home/god/github/repo", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload lookupResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.ID != id {
		t.Fatalf("id = %d, want %d", payload.ID, id)
	}
	var config map[string]any
	if err := json.Unmarshal(payload.Config, &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if config["token"] != "[ENCRYPTED]" {
		t.Fatalf("token = %v", config["token"])
	}
}

func TestLookupExpandsHomeAndStripsTrailingSlash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	h := newHarness(t)
	id := h.seedSource("git-local", "repo", `{"owner":"`+home+`/github/repo","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path="+queryEscape("~/github/repo/"), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload lookupResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.ID != id {
		t.Fatalf("id = %d, want %d", payload.ID, id)
	}
}

func TestLookupMatchesViaRealpathEquivalence(t *testing.T) {
	base := t.TempDir()
	realRepo := filepath.Join(base, "real-repo")
	if err := os.MkdirAll(realRepo, 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkRepo := filepath.Join(base, "symlink-repo")
	if err := os.Symlink(realRepo, symlinkRepo); err != nil {
		t.Fatal(err)
	}

	h := newHarness(t)
	id := h.seedSource("git-local", "repo", `{"owner":"`+realRepo+`","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path="+queryEscape(symlinkRepo), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload lookupResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.ID != id {
		t.Fatalf("id = %d, want %d", payload.ID, id)
	}
}

// TestLookupFallsBackToStringMatchWhenPathMissing 对应 vitest 的
// 「input path 不在磁盘上时退化为纯字符串匹配」。
func TestLookupFallsBackToStringMatchWhenPathMissing(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "repo", `{"owner":"/home/god/github/repo","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path=/home/god/github/repo", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload lookupResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.ID != id {
		t.Fatalf("id = %d, want %d", payload.ID, id)
	}
}

func TestLookupReturnsNotFound(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-local", "repo", `{"owner":"/home/god/github/repo","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path=/nonexistent", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "NOT_FOUND" {
		t.Fatalf("code = %q", code)
	}

	empty := newHarness(t)
	rec = empty.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path=/home/god/github/repo", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status with no sources = %d", rec.Code)
	}
}

// TestLookupPicksEarliestID 覆盖「多条命中时最早 id 胜出」（route.ts 的
// sort((a, b) => a.id - b.id)）。
func TestLookupPicksEarliestID(t *testing.T) {
	h := newHarness(t)
	earliest := h.seedSource("git-local", "older", `{"owner":"/same/path","authorEmails":["a@b.c"]}`)
	h.seedSource("git-local", "newer", `{"owner":"/same/path","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path="+queryEscape("/same/path"), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload lookupResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.ID != earliest {
		t.Fatalf("id = %d, want earliest %d", payload.ID, earliest)
	}
}

// TestLookupOnlySearchesLocalSources 覆盖 findMany 的 type 过滤。
func TestLookupOnlySearchesLocalSources(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-remote-github", "remote", `{"owner":"/same/path","repo":"r","token":"t","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/lookup?type=git-local&path="+queryEscape("/same/path"), "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}
