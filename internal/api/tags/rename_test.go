package tags_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/tags/rename/route.test.ts 的 Go 同用例集（ADR-0029）：
// 5 条用例逐条对应，另补 401 与 DB 故障的 catch 分支、以及 zod 的 details.issues 形状。

type renameResponse struct {
	EventsUpdated int64 `json:"eventsUpdated"`
	Merged        bool  `json:"merged"`
	Error         string
	Code          string
	Details       *struct {
		Issues []struct {
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"issues"`
	} `json:"details"`
}

func decodeRename(t *testing.T, body []byte) renameResponse {
	t.Helper()
	var resp renameResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func TestRenameTagWithoutMerge(t *testing.T) {
	h := newHarness(t)
	first := h.seedEvent("完成评审 #工作", "manual", 1_700_000_000)
	second := h.seedEvent("继续 #工作 收尾", "manual", 1_700_000_100)
	h.seedTag(first, "工作")
	h.seedTag(second, "工作")

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"工作","to":"任务"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if resp.EventsUpdated != 2 {
		t.Fatalf("eventsUpdated = %d, want 2", resp.EventsUpdated)
	}
	if resp.Merged {
		t.Fatalf("merged = true, want false")
	}

	// 双存储两侧都要跟上（ADR-0012）。
	if got := h.eventContent(first); got != "完成评审 #任务" {
		t.Fatalf("content = %q", got)
	}
	if names := h.tagNames(first); len(names) != 1 || names[0] != "任务" {
		t.Fatalf("tags = %v, want [任务]", names)
	}
}

func TestRenameTagReportsMergeWhenTargetAlreadyPresent(t *testing.T) {
	h := newHarness(t)
	// 目标 tag 已存在于这条事件上：rename 必须变成 merge，且不能撞唯一索引。
	overlap := h.seedEvent("两样都有 #工作 #任务", "manual", 1_700_000_000)
	h.seedTag(overlap, "工作")
	h.seedTag(overlap, "任务")

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"工作","to":"任务"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if !resp.Merged {
		t.Fatalf("merged = false, want true")
	}
	if resp.EventsUpdated != 1 {
		t.Fatalf("eventsUpdated = %d, want 1", resp.EventsUpdated)
	}
	// 重叠事件上只剩一行「任务」：改名那一半不是新增，是去重。
	if names := h.tagNames(overlap); len(names) != 1 || names[0] != "任务" {
		t.Fatalf("tags = %v, want [任务]", names)
	}
	// 内容里的旧 tag 仍然按词边界改成新名（重复写新名，与 route.ts 一致）。
	if got := h.eventContent(overlap); got != "两样都有 #任务 #任务" {
		t.Fatalf("content = %q", got)
	}
}

func TestRenameTagReturnsZeroWhenSourceTagAbsent(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("没有这个 tag", "manual", 1_700_000_000)

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"工作","to":"任务"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if resp.EventsUpdated != 0 || resp.Merged {
		t.Fatalf("resp = %+v, want 0/false", resp)
	}
	if got := h.eventContent(id); got != "没有这个 tag" {
		t.Fatalf("content = %q, must be untouched", got)
	}
}

func TestRenameTagRejectsInvalidCharset(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("原样 #工作", "manual", 1_700_000_000)
	h.seedTag(id, "工作")

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"tag-name","to":"任务"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if resp.Error != "Validation failed" || resp.Code != "VALIDATION_ERROR" {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.Details == nil || len(resp.Details.Issues) == 0 {
		t.Fatalf("details.issues missing: %s", rec.Body.String())
	}
	// zod 的 issue.path.join('.')：顶层字段名。
	if resp.Details.Issues[0].Path != "from" {
		t.Fatalf("issues[0].path = %q, want from", resp.Details.Issues[0].Path)
	}
	// 校验失败不得落库。
	if names := h.tagNames(id); len(names) != 1 || names[0] != "工作" {
		t.Fatalf("tags = %v, must be untouched", names)
	}
}

func TestRenameTagRejectsMissingField(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"工作"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if resp.Code != "VALIDATION_ERROR" {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.Details == nil || len(resp.Details.Issues) != 1 {
		t.Fatalf("issues = %+v", resp.Details)
	}
	// zod v4 对 string 缺失的 issue：path=字段名，message=Invalid input: expected
	// string, received undefined（实测 zod 4.4.3）。
	if resp.Details.Issues[0].Path != "to" {
		t.Fatalf("issues[0].path = %q, want to", resp.Details.Issues[0].Path)
	}
	if !strings.Contains(resp.Details.Issues[0].Message, "expected string") {
		t.Fatalf("issues[0].message = %q", resp.Details.Issues[0].Message)
	}
}

// route.ts 里 request.json() 抛错走的是 catch，也就是说非法 JSON 是 500 而不是 400。
func TestRenameTagRejectsInvalidJSONWith500(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/tags/rename", "not-json", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if resp.Code != "RENAME_ERROR" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestRenameTagReturns401WhenNotAuthenticated(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"工作","to":"任务"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRenameTagReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodPost, "/api/tags/rename", `{"from":"工作","to":"任务"}`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	resp := decodeRename(t, rec.Body.Bytes())
	if resp.Error != "Failed to rename tag" || resp.Code != "RENAME_ERROR" {
		t.Fatalf("resp = %+v", resp)
	}
}
