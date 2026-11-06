package tags_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/tags/route.test.ts 的 Go 同用例集（ADR-0029）：
// GET 两条、DELETE 三条，另补 401 与 DB 故障的 catch 分支。

type tagCountJSON struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

type tagsResponse struct {
	Tags []tagCountJSON `json:"tags"`
}

func decodeTags(t *testing.T, body []byte) tagsResponse {
	t.Helper()
	var resp tagsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func TestTagsGetReturnsTagsWithCounts(t *testing.T) {
	h := newHarness(t)
	first := h.seedEvent("完成评审 #工作", "manual", 1_700_000_000)
	second := h.seedEvent("写周报 #工作 #周报", "manual", 1_700_000_100)
	h.seedTag(first, "工作")
	h.seedTag(second, "工作")
	h.seedTag(second, "周报")

	rec := h.do(http.MethodGet, "/api/tags", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	resp := decodeTags(t, rec.Body.Bytes())
	if len(resp.Tags) != 2 {
		t.Fatalf("tags = %+v, want 2", resp.Tags)
	}
	// listTagsWithCounts 的 orderBy(asc(tagName)) 是 SQLite 的 BINARY 排序（码点序），
	// 不是 locale 序：周(U+5468) 在 工(U+5DE5) 之前。route.ts 的 mock 用例把顺序
	// 写成了「工作, 周报」，但那是 mock 返回值，不是查询语义。
	if resp.Tags[0].Name != "周报" || resp.Tags[0].Count != 1 {
		t.Fatalf("tags[0] = %+v, want 周报/1", resp.Tags[0])
	}
	if resp.Tags[1].Name != "工作" || resp.Tags[1].Count != 2 {
		t.Fatalf("tags[1] = %+v, want 工作/2", resp.Tags[1])
	}
}

func TestTagsGetReturnsEmptyArrayWhenNoTags(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/tags", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeTags(t, rec.Body.Bytes())
	if resp.Tags == nil {
		t.Fatalf("tags = null, want []")
	}
	if len(resp.Tags) != 0 {
		t.Fatalf("tags = %+v, want empty", resp.Tags)
	}
	// 空数组必须是 [] 而不是 null（客户端直接 map）。
	if !strings.Contains(rec.Body.String(), `"tags":[]`) {
		t.Fatalf("body = %s, want tags:[]", rec.Body.String())
	}
}

func TestTagsGetReturns401WhenNotAuthenticated(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/tags", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestTagsGetReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodGet, "/api/tags", "", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	if body.Error != "Failed to fetch tags" || body.Code != "FETCH_ERROR" {
		t.Fatalf("body = %+v", body)
	}
}

func TestTagsDeleteRemovesTagGlobally(t *testing.T) {
	h := newHarness(t)
	first := h.seedEvent("完成评审 #工作", "manual", 1_700_000_000)
	second := h.seedEvent("继续 #工作 收尾", "manual", 1_700_000_100)
	third := h.seedEvent("第三件 #工作", "manual", 1_700_000_200)
	other := h.seedEvent("无关 #个人", "manual", 1_700_000_300)
	for _, id := range []int64{first, second, third} {
		h.seedTag(id, "工作")
	}
	h.seedTag(other, "个人")

	rec := h.do(http.MethodDelete, "/api/tags?name=%E5%B7%A5%E4%BD%9C", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Removed int64 `json:"removed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	// removed 是「带该 tag 的事件数」，不是被改写的事件数。
	if body.Removed != 3 {
		t.Fatalf("removed = %d, want 3", body.Removed)
	}

	// 文本那一半：内容里的 #工作 被移除（ADR-0012 双存储必须同步）。
	if got := h.eventContent(first); strings.Contains(got, "#工作") {
		t.Fatalf("content = %q, #工作 must be removed", got)
	}
	if got := h.eventContent(second); got != "继续 收尾" {
		t.Fatalf("content = %q, want 继续 收尾", got)
	}
	// 关联表那一半：只剩「个人」。
	if names := h.tagNames(other); len(names) != 1 || names[0] != "个人" {
		t.Fatalf("other tags = %v", names)
	}
	if names := h.tagNames(first); len(names) != 0 {
		t.Fatalf("first tags = %v, want none", names)
	}
}

func TestTagsDeleteRejectsInvalidCharset(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("带连字符 #tag-name", "manual", 1_700_000_000)
	h.seedTag(id, "tag-name")

	rec := h.do(http.MethodDelete, "/api/tags?name=tag-name", "", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != "Invalid tag name" || body.Code != "INVALID_TAG_NAME" {
		t.Fatalf("body = %+v", body)
	}
	if names := h.tagNames(id); len(names) != 1 {
		t.Fatalf("invalid name must not delete rows, tags = %v", names)
	}
}

func TestTagsDeleteRejectsMissingName(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodDelete, "/api/tags", "", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Code != "INVALID_TAG_NAME" {
		t.Fatalf("body = %+v", body)
	}
}

// 票内点名：删除不存在的 tag（或纯数字名通过 charset 校验但不存在）返回 200 + 0。
func TestTagsDeleteReturnsZeroForUnknownTag(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodDelete, "/api/tags?name=unknown", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"removed":0`) {
		t.Fatalf("body = %s, want removed:0", rec.Body.String())
	}
}
