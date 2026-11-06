package events_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/events/[id]/route.test.ts 的 Go 同用例集（ADR-0029）：
// PUT 9 条 + DELETE 3 条逐条对应，另补 GET（route.ts 有 GET 但 vitest 没测）与
// 401 / DB 故障分支。断言跑在真实 SQLite 上，因此 updateData 的「undefined 不写」
// 语义也一并被证明。

func TestGetEventReturnsRowWithTags(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("完成评审 #成果", "manual", 1_704_672_000, "")
	h.seedTag(id, "成果")

	rec := h.do(http.MethodGet, "/api/events/"+itoa(id), "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got struct {
		eventsBodyJSON
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != id || got.Content != "完成评审 #成果" {
		t.Fatalf("event = %+v", got.eventsBodyJSON)
	}
	if len(got.Tags) != 1 || got.Tags[0] != "成果" {
		t.Fatalf("tags = %v", got.Tags)
	}
	// 没有 tag 的事件必须回 []，不能是 null。
	plain := h.seedEvent("plain", "manual", 1_704_758_400, "")
	rec = h.do(http.MethodGet, "/api/events/"+itoa(plain), "", testPassword)
	if !strings.Contains(rec.Body.String(), `"tags":[]`) {
		t.Fatalf("body = %s, want tags:[]", rec.Body.String())
	}
}

// parseInt 的怪癖（B1 先例）："1abc" → 1，"abc" → NaN → 400。
func TestGetEventParseIntIDSemantics(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("event", "manual", 1_704_672_000, "")

	if rec := h.do(http.MethodGet, "/api/events/"+itoa(id)+"abc", "", testPassword); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for '1abc'", rec.Code)
	}
	rec := h.do(http.MethodGet, "/api/events/abc", "", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	// route.ts 这条分支只回 {error}，没有 code 字段。
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "Invalid event ID" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if _, hasCode := body["code"]; hasCode {
		t.Fatalf("body = %s, want no code field", rec.Body.String())
	}
}

func TestGetEventReturns404ForMissingRow(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/events/999", "", testPassword)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "Event not found" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPutEventUpdatesContentAndSyncsTags(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")
	h.seedTag(id, "旧标签")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id),
		`{"content":"更新后的内容 #成果","isImportant":true}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var updated eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if updated.Content != "更新后的内容 #成果" {
		t.Fatalf("content = %q", updated.Content)
	}
	if updated.IsImportant == nil || !*updated.IsImportant {
		t.Fatalf("isImportant = %v", updated.IsImportant)
	}
	// syncEventTags 先删后插：旧标签必须消失，只剩新内容里解析出的那个。
	var names []string
	rows, err := h.sqlDB.Query(`SELECT tag_name FROM event_tags WHERE event_id = ? ORDER BY tag_name`, id)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if len(names) != 1 || names[0] != "成果" {
		t.Fatalf("tags = %v, want [成果]", names)
	}
}

func TestPutEventUpdatesTimeWithoutSyncingTags(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Test event", "manual", 1_704_672_000, "")
	h.seedTag(id, "保留")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"eventTime":"2024-01-15T10:00:00.000Z"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var updated eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.EventTime != "2024-01-15T10:00:00.000Z" {
		t.Fatalf("eventTime = %q", updated.EventTime)
	}
	// 内容没变 → 标签不同步（route.ts 的 `body.content !== undefined` 门）。
	var count int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM event_tags WHERE event_id = ?`, id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("tag rows = %d, want 1 (untouched)", count)
	}
}

// 非手动事件即使改了 content 也不同步标签：route.ts 的条件是
// `body.content !== undefined && event[0].source === 'manual'`。
func TestPutEventSkipsTagSyncForNonManualEvent(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("github event body", "github", 1_704_672_000, "")
	h.seedTag(id, "原始")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"content":"github event body #新标签"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if names := h.tagNames(id); len(names) != 1 || names[0] != "原始" {
		t.Fatalf("tags = %v, want untouched [原始]", names)
	}
}

func TestPutEventReturns404ForMissingRow(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPut, "/api/events/999", `{"content":"Test"}`, testPassword)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if msg, _ := decodeError(t, rec.Body.Bytes()); msg != "Event not found" {
		t.Fatalf("error = %q", msg)
	}
}

func TestPutEventRejectsEmptyContent(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"content":""}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Content is required" || code != "INVALID_CONTENT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestPutEventRejectsWhitespaceOnlyContent(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"content":"   "}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if _, code := decodeError(t, rec.Body.Bytes()); code != "INVALID_CONTENT" {
		t.Fatalf("code = %q", code)
	}
}

func TestPutEventRejectsInvalidEventTime(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"eventTime":"invalid-date"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Invalid event time" || code != "INVALID_EVENT_TIME" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestPutEventRejectsNonBooleanIsImportant(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"isImportant":"yes"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	msg, code := decodeError(t, rec.Body.Bytes())
	if msg != "isImportant must be a boolean" || code != "INVALID_IS_IMPORTANT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestPutEventRejectsMalformedJSON(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), "not-json", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Invalid request body" || code != "INVALID_BODY" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

// route.ts 的这组分支值得逐字钉住：
//   - JSON `null` → `!body` 为真 → 400 EMPTY_BODY（不是 route.ts 注释里说的「空 body」，
//     而是任何 falsy body）；
//   - JSON 数组是 object 且 truthy → 穿过检查，没有任何已知字段 → 只刷新 updatedAt，
//     回 200。这是 route.ts 的实际行为，按票面「逐字移植」保留。
func TestPutEventEmptyBodyBranches(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), "null", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("null body status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Request body cannot be empty" || code != "EMPTY_BODY" {
		t.Fatalf("error = %q/%q", msg, code)
	}

	rec = h.do(http.MethodPut, "/api/events/"+itoa(id), "[1,2]", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("array body status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var updated eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Content != "Original content" {
		t.Fatalf("content = %q, want untouched", updated.Content)
	}
}

func TestPutEventAcceptsBooleanFalseIsImportant(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Original content", "manual", 1_704_672_000, "")
	if _, err := h.sqlDB.Exec(`UPDATE raw_events SET is_important = 1 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}

	rec := h.do(http.MethodPut, "/api/events/"+itoa(id), `{"isImportant":false}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var updated eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.IsImportant == nil || *updated.IsImportant {
		t.Fatalf("isImportant = %v, want false", updated.IsImportant)
	}
	if names := h.tagNames(id); len(names) != 0 {
		t.Fatalf("tags = %v, want untouched (no content change)", names)
	}
}

func TestDeleteEventRemovesManualEventAndTagRows(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("Test event", "manual", 1_704_672_000, "")
	h.seedTag(id, "成果")

	rec := h.do(http.MethodDelete, "/api/events/"+itoa(id), "", testPassword)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "" {
		t.Fatalf("body = %q, want empty", body)
	}
	if n := h.countRows(t, `SELECT COUNT(*) FROM raw_events WHERE id = ?`, id); n != 0 {
		t.Fatalf("event rows = %d, want 0", n)
	}
	if n := h.countRows(t, `SELECT COUNT(*) FROM event_tags WHERE event_id = ?`, id); n != 0 {
		t.Fatalf("tag rows = %d, want 0", n)
	}
}

func TestDeleteEventRejectsNonManualEvent(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("GitHub event", "github", 1_704_672_000, "")

	rec := h.do(http.MethodDelete, "/api/events/"+itoa(id), "", testPassword)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	// 403 分支只回 {error}，没有 code 字段。
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "Cannot delete non-manual event" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if _, hasCode := body["code"]; hasCode {
		t.Fatalf("body = %s, want no code field", rec.Body.String())
	}
	if n := h.countRows(t, `SELECT COUNT(*) FROM raw_events WHERE id = ?`, id); n != 1 {
		t.Fatalf("event rows = %d, want 1 (must not be deleted)", n)
	}
}

func TestDeleteEventReturns404ForMissingRow(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodDelete, "/api/events/999", "", testPassword)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if msg, _ := decodeError(t, rec.Body.Bytes()); msg != "Event not found" {
		t.Fatalf("error = %q", msg)
	}
}

// 票内点名（delete-consequences.test.ts 的语义）：删除事件只清「指向它的」
// 引用索引行，评论正文原样保留（悬挂引用是设计，不是 bug）。
func TestDeleteEventRemovesOnlyItsCommentCitations(t *testing.T) {
	h := newHarness(t)
	target := h.seedEvent("Target event", "manual", 1_704_672_000, "")
	other := h.seedEvent("Other event", "manual", 1_704_758_400, "")
	item := h.seedPlanItem()
	targetComment := h.citeComment(item, target)
	otherComment := h.citeComment(item, other)

	rec := h.do(http.MethodDelete, "/api/events/"+itoa(target), "", testPassword)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}

	if n := h.countRows(t, `SELECT COUNT(*) FROM raw_events WHERE id = ?`, target); n != 0 {
		t.Fatalf("target rows = %d, want 0", n)
	}
	if n := h.countRows(t, `SELECT COUNT(*) FROM plan_item_comments`); n != 2 {
		t.Fatalf("comment rows = %d, want 2 (text survives)", n)
	}
	var content string
	if err := h.sqlDB.QueryRow(`SELECT content FROM plan_item_comments WHERE id = ?`, targetComment).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if content != "Cites @"+itoa(target) {
		t.Fatalf("comment content = %q", content)
	}
	if n := h.countRows(t, `SELECT COUNT(*) FROM comment_references`); n != 1 {
		t.Fatalf("citation rows = %d, want 1", n)
	}
	var commentID, referencedID int64
	if err := h.sqlDB.QueryRow(`SELECT comment_id, referenced_event_id FROM comment_references`).Scan(&commentID, &referencedID); err != nil {
		t.Fatal(err)
	}
	if commentID != otherComment || referencedID != other {
		t.Fatalf("remaining citation = %d->%d, want %d->%d", commentID, referencedID, otherComment, other)
	}
}

// ADR-0016：两个方向都要清 —— 本事件写的引用行（event_id）与指向它的行
// （referenced_event_id）。悬挂的 @id 文本保留在内容里。
func TestDeleteEventClearsEventReferencesInBothDirections(t *testing.T) {
	h := newHarness(t)
	target := h.seedEvent("被引用的 #事件", "manual", 1_704_672_000, "")
	outgoing := h.seedEvent("引用别人 @999", "manual", 1_704_758_400, "")
	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_references (event_id, referenced_event_id, created_at) VALUES (?, ?, 0), (?, ?, 0)`,
		outgoing, target, target, 999,
	); err != nil {
		t.Fatal(err)
	}

	rec := h.do(http.MethodDelete, "/api/events/"+itoa(target), "", testPassword)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	// outgoing → target 与 target → 999 两行都该消失。
	if n := h.countRows(t, `SELECT COUNT(*) FROM event_references`); n != 0 {
		t.Fatalf("reference rows = %d, want 0", n)
	}
	// 内容里的 @999 文本保留（悬挂引用）。
	var content string
	if err := h.sqlDB.QueryRow(`SELECT content FROM raw_events WHERE id = ?`, outgoing).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if content != "引用别人 @999" {
		t.Fatalf("content = %q, want untouched", content)
	}
}

func TestEventsIDRequiresAuth(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("event", "manual", 1_704_672_000, "")

	cases := []struct{ method, path string }{
		{http.MethodGet, "/api/events/" + itoa(id)},
		{http.MethodPut, "/api/events/" + itoa(id)},
		{http.MethodDelete, "/api/events/" + itoa(id)},
	}
	for _, tc := range cases {
		rec := h.do(tc.method, tc.path, "", "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

func TestPutEventReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodPut, "/api/events/1", `{"content":"x"}`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Failed to update event" || code != "UPDATE_ERROR" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

// ADR-0016：创建/更新手动事件时把 @id 引用与 %id 计划引用写进索引表；
// 再次保存时旧索引行被清掉、只留新内容里的引用。
func TestEventReferenceSyncOnCreateAndUpdate(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events",
		`{"content":"关联 @7 和 @9 与 %12 以及 @0 @7"}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	// @0 被 route.ts 的 `id > 0` 丢弃；@7 重复只留一行。
	refs := h.columnInts(t, `SELECT referenced_event_id FROM event_references WHERE event_id = ? ORDER BY referenced_event_id`, created.ID)
	if len(refs) != 2 || refs[0] != 7 || refs[1] != 9 {
		t.Fatalf("event_references = %v, want [7 9]", refs)
	}
	planRefs := h.columnInts(t, `SELECT plan_item_id FROM event_plan_references WHERE event_id = ?`, created.ID)
	if len(planRefs) != 1 || planRefs[0] != 12 {
		t.Fatalf("event_plan_references = %v, want [12]", planRefs)
	}

	// 更新内容：旧索引全清，只留新内容里的 @8 与 %3。
	rec = h.do(http.MethodPut, "/api/events/"+itoa(created.ID), `{"content":"改成 @8 且 %3"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, body %s", rec.Code, rec.Body.String())
	}
	after := h.columnInts(t, `SELECT referenced_event_id FROM event_references WHERE event_id = ?`, created.ID)
	if len(after) != 1 || after[0] != 8 {
		t.Fatalf("event_references after update = %v, want [8]", after)
	}
	afterPlans := h.columnInts(t, `SELECT plan_item_id FROM event_plan_references WHERE event_id = ?`, created.ID)
	if len(afterPlans) != 1 || afterPlans[0] != 3 {
		t.Fatalf("event_plan_references after update = %v, want [3]", afterPlans)
	}
}

// DELETE 也清 event_plan_references（event_id 方向）。
func TestDeleteEventClearsPlanReferences(t *testing.T) {
	h := newHarness(t)
	id := h.seedEvent("带计划引用 %5", "manual", 1_704_672_000, "")
	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_plan_references (event_id, plan_item_id, created_at) VALUES (?, 5, 0)`, id,
	); err != nil {
		t.Fatal(err)
	}

	rec := h.do(http.MethodDelete, "/api/events/"+itoa(id), "", testPassword)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	if n := h.countRows(t, `SELECT COUNT(*) FROM event_plan_references WHERE event_id = ?`, id); n != 0 {
		t.Fatalf("plan refs = %d, want 0", n)
	}
}
