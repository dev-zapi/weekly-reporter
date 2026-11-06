package sources_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件是 src/app/api/collect/sources/[id]/route.test.ts 的 Go 同用例集
// （ADR-0029）：PUT 的 3 条 aliases 用例逐条对应，另外补齐 GET/PATCH/DELETE 的
// 成功与错误形状（该路由文件在同一张票内，行为以 route.ts 为准）。

const localBody = `"type":"git-local","name":"new-name","projectScope":"personal","config":{"owner":"/tmp/alpha","authorEmails":["dev@example.com"]}`

func putBody(extra string) string {
	if extra == "" {
		return "{" + localBody + "}"
	}
	return "{" + localBody + "," + extra + "}"
}

// TestPutPersistsTopLevelAliases 对应 vitest 的第 1 条：
// 顶层 aliases 必须落进 config.aliases。
func TestPutPersistsTopLevelAliases(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "old-name", `{"owner":"/tmp/alpha","authorEmails":["dev@example.com"]}`)

	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/"+itoa(id), putBody(`"aliases":["ax"]`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var config map[string]any
	if err := json.Unmarshal(rawConfigOf(t, rec.Body.Bytes()), &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	aliases, _ := config["aliases"].([]any)
	if len(aliases) != 1 || aliases[0] != "ax" {
		t.Fatalf("config.aliases = %v, want [ax]", config["aliases"])
	}
	if h.load(id).Name != "new-name" {
		t.Fatalf("stored name = %q", h.load(id).Name)
	}
}

// TestPutClearsAliasesWhenAbsent 对应 vitest 的第 2 条：全量替换语义。
func TestPutClearsAliasesWhenAbsent(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "old-name", `{"owner":"/tmp/alpha","authorEmails":["dev@example.com"],"aliases":["old-alias"]}`)

	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/"+itoa(id), putBody(""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var config map[string]any
	if err := json.Unmarshal(rawConfigOf(t, rec.Body.Bytes()), &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if _, present := config["aliases"]; present {
		t.Fatalf("config.aliases still present: %v", config)
	}
}

// TestPutRejectsAliasOwnedByAnotherSource 对应 vitest 的第 3 条：
// 查重排除自身、但别人占用的别名要拒绝。
func TestPutRejectsAliasOwnedByAnotherSource(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "self", `{"owner":"/tmp/alpha","authorEmails":["dev@example.com"],"aliases":["ax"]}`)
	h.seedSource("git-local", "other", `{"owner":"/tmp/other","authorEmails":["dev@example.com"],"aliases":["taken"]}`)

	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/"+itoa(id), putBody(`"aliases":["ax","taken"]`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	message, code := decodeErrorCode(t, rec.Body.Bytes())
	if code != "DUPLICATE_ALIAS" || message != "别名已被使用: taken" {
		t.Fatalf("error/code = %q/%q", message, code)
	}
	if h.load(id).Name != "self" {
		t.Fatalf("row was updated despite the rejection")
	}
}

// TestPutPreservesStoredToken 覆盖 route.ts 的 token 保留规则：
// 远程来源的表单把 token 回显成 [ENCRYPTED]，PUT 必须换回库里的真实 token。
func TestPutPreservesStoredToken(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-remote-github", "remote", `{"owner":"org","repo":"repo","token":"stored-token","authorEmails":["dev@example.com"]}`)

	body := `{"type":"git-remote-github","name":"remote","projectScope":"work","config":{"owner":"org","repo":"repo","token":"[ENCRYPTED]","authorEmails":["dev@example.com"]}}`
	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/"+itoa(id), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var config map[string]any
	if err := json.Unmarshal(rawConfigOf(t, rec.Body.Bytes()), &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if config["token"] != "[ENCRYPTED]" {
		t.Fatalf("response token = %v, want masked", config["token"])
	}

	stored := h.load(id)
	if !containsSubstring(stored.Config, `"token":"stored-token"`) {
		t.Fatalf("stored config = %s", stored.Config)
	}
}

// TestPutPreservesBranchCursors 覆盖 PUT 的游标保留：表单不发送 branchCursors，
// 库里已有的游标不能被清掉。
func TestPutPreservesBranchCursors(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "old-name",
		`{"owner":"/tmp/alpha","authorEmails":["a@b.c"],"branches":["main"],"branchCursors":[{"name":"main","lastCommitTime":"2026-01-01T00:00:00.000Z"}]}`)

	body := `{"type":"git-local","name":"new-name","projectScope":"personal","config":{"owner":"/tmp/alpha","authorEmails":["a@b.c"],"branches":["main"]}}`
	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/"+itoa(id), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	stored := h.load(id)
	if !containsSubstring(stored.Config, `"branchCursors":[{"name":"main","lastCommitTime":"2026-01-01T00:00:00.000Z"}]`) {
		t.Fatalf("stored config = %s", stored.Config)
	}
	// mergeEditedBranches 把 branches 归一成 {name, lastCommitTime}；游标只从
	// 现有的 branches 条目（这里是字符串 "main"，无游标）继承，所以是 null。
	if !containsSubstring(stored.Config, `"branches":[{"name":"main","lastCommitTime":null}]`) {
		t.Fatalf("stored config = %s", stored.Config)
	}
}

// TestPutInvalidIDAndNotFound 覆盖 400 INVALID_ID / 404 NOT_FOUND。
func TestPutInvalidIDAndNotFound(t *testing.T) {
	h := newHarness(t)

	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/abc", putBody(""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_ID" {
		t.Fatalf("code = %q", code)
	}

	rec = h.doAuthed(http.MethodPut, "/api/collect/sources/999", putBody(""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "NOT_FOUND" {
		t.Fatalf("code = %q", code)
	}
}

// TestPutValidationErrorShape 覆盖 PUT 的 zod 失败形状。
func TestPutValidationErrorShape(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "old-name", `{"owner":"/tmp/alpha","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodPut, "/api/collect/sources/"+itoa(id), `{"type":"git-local"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "VALIDATION_ERROR" {
		t.Fatalf("code = %q", code)
	}
}

// TestGetSourceMasksToken 覆盖 GET {id} 的 happy path。
func TestGetSourceMasksToken(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-remote-github", "remote", `{"owner":"org","repo":"repo","token":"secret","authorEmails":["a@b.c"]}`, withLastSync(1700000000, "success"))

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/"+itoa(id), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var source struct {
		ID           int64           `json:"id"`
		Config       json.RawMessage `json:"config"`
		Enabled      bool            `json:"enabled"`
		LastSyncAt   *string         `json:"lastSyncAt"`
		ProjectScope string          `json:"projectScope"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &source); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if source.ID != id || !source.Enabled || source.ProjectScope != "personal" {
		t.Fatalf("source = %+v", source)
	}
	if source.LastSyncAt == nil || *source.LastSyncAt != "2023-11-14T22:13:20.000Z" {
		t.Fatalf("lastSyncAt = %v", source.LastSyncAt)
	}
	var config map[string]any
	if err := json.Unmarshal(source.Config, &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if config["token"] != "[ENCRYPTED]" {
		t.Fatalf("token = %v", config["token"])
	}
}

func TestGetSourceInvalidIDAndNotFound(t *testing.T) {
	h := newHarness(t)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources/abc", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "INVALID_ID" {
		t.Fatalf("code = %q", code)
	}

	rec = h.doAuthed(http.MethodGet, "/api/collect/sources/999", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "NOT_FOUND" {
		t.Fatalf("code = %q", code)
	}
}

// TestPatchTogglesEnabledAndStatus 覆盖 PATCH 的白名单字段。
func TestPatchTogglesEnabledAndStatus(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "p", `{"owner":"/tmp/p","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodPatch, "/api/collect/sources/"+itoa(id), `{"enabled":false,"status":"disabled"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	stored := h.load(id)
	if stored.Enabled != 0 || stored.Status == nil || *stored.Status != "disabled" {
		t.Fatalf("stored = %+v", stored)
	}

	// 非白名单 status 被忽略。
	rec = h.doAuthed(http.MethodPatch, "/api/collect/sources/"+itoa(id), `{"status":"bogus","enabled":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	stored = h.load(id)
	if stored.Enabled != 1 || stored.Status == nil || *stored.Status != "disabled" {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestPatchRemoveBranch 覆盖三分支：不存在 → 404、最后一个 → 400、成功。
func TestPatchRemoveBranch(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "p", `{"owner":"/tmp/p","authorEmails":["a@b.c"],"branches":["main","dev"]}`)

	rec := h.doAuthed(http.MethodPatch, "/api/collect/sources/"+itoa(id), `{"removeBranch":"nope"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "BRANCH_NOT_FOUND" {
		t.Fatalf("code = %q", code)
	}

	rec = h.doAuthed(http.MethodPatch, "/api/collect/sources/"+itoa(id), `{"removeBranch":"dev"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	stored := h.load(id)
	if !containsSubstring(stored.Config, `"branches":["main"]`) {
		t.Fatalf("stored config = %s", stored.Config)
	}

	rec = h.doAuthed(http.MethodPatch, "/api/collect/sources/"+itoa(id), `{"removeBranch":"main"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "LAST_BRANCH" {
		t.Fatalf("code = %q", code)
	}
}

// TestPatchNoBranchesConfigured 覆盖 NO_BRANCHES。
func TestPatchNoBranchesConfigured(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "p", `{"owner":"/tmp/p","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodPatch, "/api/collect/sources/"+itoa(id), `{"removeBranch":"main"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "NO_BRANCHES" {
		t.Fatalf("code = %q", code)
	}
}

// TestDeleteSource 覆盖 DELETE 的成功与 404。
func TestDeleteSource(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource("git-local", "p", `{"owner":"/tmp/p","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodDelete, "/api/collect/sources/"+itoa(id), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || !payload.Success {
		t.Fatalf("payload = %+v err %v", payload, err)
	}

	var count int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM collect_sources`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("row count = %d", count)
	}

	rec = h.doAuthed(http.MethodDelete, "/api/collect/sources/"+itoa(id), "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if _, code := decodeErrorCode(t, rec.Body.Bytes()); code != "NOT_FOUND" {
		t.Fatalf("code = %q", code)
	}
}

func rawConfigOf(t *testing.T, body []byte) json.RawMessage {
	t.Helper()
	var payload struct {
		Config json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return payload.Config
}

func containsSubstring(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
