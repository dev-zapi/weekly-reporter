package snippets

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/snippets/route.test.ts 的 Go 同用例集（ADR-0029）：
// GET 3 条 + POST 7 条逐条对应；snippets/[id] 没有 vitest，按 route.ts 的行为补
// DELETE 的成功/404/403/非法 id 与 401 分支（票面要求 export 补 happy path，
// 同一原则适用于这条无测试的路由）。

type snippetBodyJSON struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	Category  string `json:"category"`
	IsBuiltIn bool   `json:"isBuiltIn"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type snippetsResponse struct {
	Snippets []snippetBodyJSON `json:"snippets"`
}

func decodeSnippets(t *testing.T, body []byte) snippetsResponse {
	t.Helper()
	var resp snippetsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func decodeError(t *testing.T, body []byte) (string, string, string) {
	t.Helper()
	var resp struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details string `json:"details"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode error body %s: %v", body, err)
	}
	return resp.Error, resp.Code, resp.Details
}

func TestSnippetsGetReturnsAllSnippets(t *testing.T) {
	h := newHarness(t)
	h.seedSnippet("Snippet 1", "工作进展", true)
	h.seedSnippet("Snippet 2", "下周计划", false)

	rec := h.do(http.MethodGet, "/api/snippets", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decodeSnippets(t, rec.Body.Bytes())
	if len(resp.Snippets) != 2 {
		t.Fatalf("snippets = %+v", resp.Snippets)
	}
	// 行对象按 drizzle 的列映射序列化：camelCase + boolean + ISO 时间字符串。
	if resp.Snippets[0].Content != "Snippet 1" || !resp.Snippets[0].IsBuiltIn {
		t.Fatalf("snippet = %+v", resp.Snippets[0])
	}
	if resp.Snippets[0].CreatedAt != "2023-11-14T22:13:20.000Z" {
		t.Fatalf("createdAt = %q", resp.Snippets[0].CreatedAt)
	}
	if resp.Snippets[1].Content != "Snippet 2" || resp.Snippets[1].IsBuiltIn {
		t.Fatalf("snippet = %+v", resp.Snippets[1])
	}
}

func TestSnippetsGetFiltersByCategory(t *testing.T) {
	h := newHarness(t)
	h.seedSnippet("Snippet 1", "工作进展", true)
	h.seedSnippet("Snippet 2", "下周计划", false)

	rec := h.do(http.MethodGet, "/api/snippets?category="+urlEscape("工作进展"), "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeSnippets(t, rec.Body.Bytes())
	if len(resp.Snippets) != 1 || resp.Snippets[0].Category != "工作进展" {
		t.Fatalf("snippets = %+v", resp.Snippets)
	}
}

// `category ? ... : ...`：空字符串是 falsy，退回「全部」。
func TestSnippetsGetTreatsEmptyCategoryAsNoFilter(t *testing.T) {
	h := newHarness(t)
	h.seedSnippet("a", "工作进展", false)
	h.seedSnippet("b", "下周计划", false)

	rec := h.do(http.MethodGet, "/api/snippets?category=", "", testPassword)
	if resp := decodeSnippets(t, rec.Body.Bytes()); len(resp.Snippets) != 2 {
		t.Fatalf("snippets = %d, want 2", len(resp.Snippets))
	}
}

func TestSnippetsGetReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodGet, "/api/snippets", "", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	msg, code, details := decodeError(t, rec.Body.Bytes())
	if msg != "Failed to load snippets" || code != "FETCH_ERROR" {
		t.Fatalf("error = %q/%q", msg, code)
	}
	// route.ts 还会带 details: String(error)（诊断字段，文本不冻结）。
	if details == "" {
		t.Fatalf("details missing: %s", rec.Body.String())
	}
}

func TestSnippetsPostCreatesSnippet(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":"New snippet"}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Snippet snippetBodyJSON `json:"snippet"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Snippet.Content != "New snippet" {
		t.Fatalf("snippet = %+v", created.Snippet)
	}
	// route.ts 显式写 `category: body.category || 'General'`（不是 schema 默认值 通用）。
	if created.Snippet.Category != "General" {
		t.Fatalf("category = %q, want General", created.Snippet.Category)
	}
	if created.Snippet.IsBuiltIn {
		t.Fatalf("isBuiltIn = true, want false")
	}
}

func TestSnippetsPostCreatesSnippetWithCustomCategory(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":"New snippet","category":"工作进展"}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Snippet snippetBodyJSON `json:"snippet"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Snippet.Category != "工作进展" {
		t.Fatalf("category = %q", created.Snippet.Category)
	}
}

func TestSnippetsPostRejectsEmptyContent(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":""}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	msg, code, _ := decodeError(t, rec.Body.Bytes())
	if msg != "Content is required" || code != "INVALID_INPUT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestSnippetsPostRejectsContentLongerThan500(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":"`+strings.Repeat("a", 501)+`"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	msg, code, _ := decodeError(t, rec.Body.Bytes())
	if msg != "Content must be 500 characters or fewer" || code != "INVALID_INPUT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

// `body.content.length` 是 UTF-16 单元数：500 个汉字合法，501 个不合法，
// 与 Go 的 len()（字节）不同。
func TestSnippetsPostCountsContentInUTF16Units(t *testing.T) {
	h := newHarness(t)

	ok := h.do(http.MethodPost, "/api/snippets", `{"content":"`+strings.Repeat("一", 500)+`"}`, testPassword)
	if ok.Code != http.StatusCreated {
		t.Fatalf("500 CJK chars status = %d, want 201 (body %s)", ok.Code, ok.Body.String())
	}
	tooLong := h.do(http.MethodPost, "/api/snippets", `{"content":"`+strings.Repeat("一", 501)+`"}`, testPassword)
	if tooLong.Code != http.StatusBadRequest {
		t.Fatalf("501 CJK chars status = %d, want 400", tooLong.Code)
	}
}

func TestSnippetsPostRejectsInvalidCategoryType(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":"Valid content","category":123}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	msg, code, _ := decodeError(t, rec.Body.Bytes())
	if msg != "Category must be a string" || code != "INVALID_INPUT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestSnippetsPostReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":"Valid content"}`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	msg, code, _ := decodeError(t, rec.Body.Bytes())
	if msg != "Failed to create snippet" || code != "CREATE_ERROR" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

// `isBuiltIn: false` 是硬编码的：请求里传 true 也不生效。
func TestSnippetsPostAlwaysSetsIsBuiltInFalse(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", `{"content":"New snippet","isBuiltIn":true}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}
	var created struct {
		Snippet snippetBodyJSON `json:"snippet"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Snippet.IsBuiltIn {
		t.Fatalf("isBuiltIn = true, want false")
	}
	var stored int64
	if err := h.sqlDB.QueryRow(`SELECT is_built_in FROM sentence_snippets WHERE id = ?`, created.Snippet.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Fatalf("is_built_in = %d, want 0", stored)
	}
}

// route.ts 里 request.json() 抛错走 catch → 500 CREATE_ERROR。
func TestSnippetsPostRejectsInvalidJSONWith500(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/snippets", "not-json", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if _, code, _ := decodeError(t, rec.Body.Bytes()); code != "CREATE_ERROR" {
		t.Fatalf("code = %q", code)
	}
}

func TestSnippetsDeleteRemovesSnippet(t *testing.T) {
	h := newHarness(t)
	id := h.seedSnippet("Snippet", "通用", false)

	rec := h.do(http.MethodDelete, "/api/snippets/"+itoa(id), "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Message != "Snippet deleted successfully" {
		t.Fatalf("message = %q", body.Message)
	}
	var count int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM sentence_snippets WHERE id = ?`, id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rows = %d, want 0", count)
	}
}

func TestSnippetsDeleteRejectsInvalidID(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodDelete, "/api/snippets/abc", "", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if msg, code, _ := decodeError(t, rec.Body.Bytes()); msg != "Invalid snippet ID" || code != "INVALID_ID" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestSnippetsDeleteReturns404ForMissingRow(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodDelete, "/api/snippets/999", "", testPassword)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if msg, code, _ := decodeError(t, rec.Body.Bytes()); msg != "Snippet not found" || code != "NOT_FOUND" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestSnippetsDeleteRejectsBuiltInSnippet(t *testing.T) {
	h := newHarness(t)
	id := h.seedSnippet("内置", "通用", true)

	rec := h.do(http.MethodDelete, "/api/snippets/"+itoa(id), "", testPassword)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if msg, code, _ := decodeError(t, rec.Body.Bytes()); msg != "Built-in snippets cannot be deleted" || code != "FORBIDDEN" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestSnippetsRequireAuth(t *testing.T) {
	h := newHarness(t)
	id := h.seedSnippet("Snippet", "通用", false)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/snippets"},
		{http.MethodPost, "/api/snippets"},
		{http.MethodDelete, "/api/snippets/" + itoa(id)},
	} {
		if rec := h.do(tc.method, tc.path, "", ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}
