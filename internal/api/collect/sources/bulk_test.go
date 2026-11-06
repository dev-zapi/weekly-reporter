package sources_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件是 src/app/api/collect/sources/bulk-delete/route.test.ts 的 Go 同用例集
// （ADR-0029）：3 条逐条对应；bulk-update-scope 无 vitest，按票面补 happy path +
// `{error, code}` 错误形状。

func TestBulkDeleteDeletesSelectedSources(t *testing.T) {
	h := newHarness(t)
	id1 := h.seedSource("git-local", "one", `{"owner":"/1","authorEmails":["a@b.c"]}`)
	id2 := h.seedSource("git-local", "two", `{"owner":"/2","authorEmails":["a@b.c"]}`)
	id3 := h.seedSource("git-local", "three", `{"owner":"/3","authorEmails":["a@b.c"]}`)
	keep := h.seedSource("git-local", "keep", `{"owner":"/4","authorEmails":["a@b.c"]}`)

	body := `{"ids":[` + itoa(id1) + `,` + itoa(id2) + `,` + itoa(id3) + `]}`
	rec := h.doAuthed(http.MethodPost, "/api/collect/sources/bulk-delete", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Success      bool  `json:"success"`
		DeletedCount int64 `json:"deletedCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.Success || payload.DeletedCount != 3 {
		t.Fatalf("payload = %+v", payload)
	}
	var remaining int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM collect_sources`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("remaining = %d, want 1", remaining)
	}
	if h.load(keep).Name != "keep" {
		t.Fatalf("untouched row missing")
	}
}

func TestBulkDeleteRejectsEmptyIDs(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-local", "one", `{"owner":"/1","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodPost, "/api/collect/sources/bulk-delete", `{"ids":[]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_IDS" {
		t.Fatalf("code = %q", code)
	}
	var count int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM collect_sources`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1", count)
	}
}

func TestBulkDeleteRejectsMissingIDs(t *testing.T) {
	h := newHarness(t)

	rec := h.doAuthed(http.MethodPost, "/api/collect/sources/bulk-delete", `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_IDS" {
		t.Fatalf("code = %q", code)
	}
}

func TestBulkUpdateScopeUpdatesSelectedSources(t *testing.T) {
	h := newHarness(t)
	id1 := h.seedSource("git-local", "one", `{"owner":"/1","authorEmails":["a@b.c"]}`)
	id2 := h.seedSource("git-local", "two", `{"owner":"/2","authorEmails":["a@b.c"]}`)
	other := h.seedSource("git-local", "other", `{"owner":"/3","authorEmails":["a@b.c"]}`)

	body := `{"ids":[` + itoa(id1) + `,` + itoa(id2) + `],"projectScope":"work"}`
	rec := h.doAuthed(http.MethodPost, "/api/collect/sources/bulk-update-scope", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Success      bool  `json:"success"`
		UpdatedCount int64 `json:"updatedCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.Success || payload.UpdatedCount != 2 {
		t.Fatalf("payload = %+v", payload)
	}
	if h.load(id1).ProjectScope != "work" || h.load(id2).ProjectScope != "work" {
		t.Fatalf("selected rows were not updated")
	}
	if h.load(other).ProjectScope != "personal" {
		t.Fatalf("unselected row changed")
	}
}

func TestBulkUpdateScopeRejectsEmptyIDs(t *testing.T) {
	h := newHarness(t)

	rec := h.doAuthed(http.MethodPost, "/api/collect/sources/bulk-update-scope", `{"ids":[],"projectScope":"work"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_IDS" {
		t.Fatalf("code = %q", code)
	}
}

func TestBulkUpdateScopeRejectsInvalidScope(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "one", `{"owner":"/1","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodPost, "/api/collect/sources/bulk-update-scope", `{"ids":[`+itoa(id)+`],"projectScope":"team"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	message, code := decodeErrorCode(t, rec.Body.Bytes())
	if code != "INVALID_SCOPE" || message != "项目类型必须是 work 或 personal" {
		t.Fatalf("error/code = %q/%q", message, code)
	}
}
