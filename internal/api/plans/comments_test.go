package plans_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
)

// /api/plan-items/{id}/comments 与 .../comments/{commentId} 的用例集，逐条对照
// src/app/api/plan-items/[id]/comments/route.test.ts 与 .../[commentId]/route.test.ts。

func TestListCommentsRejectsNonNumericID(t *testing.T) {
	h := newHarness(t)

	status, _ := decode(t, h.do(http.MethodGet, "/api/plan-items/nope/comments", "", ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
}

func TestListCommentsReturns404WhenItemMissing(t *testing.T) {
	h := newHarness(t)

	status, _ := decode(t, h.do(http.MethodGet, "/api/plan-items/999/comments", "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
}

func TestListCommentsEmptyForItemWithoutComments(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if comments, ok := body["comments"].([]any); !ok || len(comments) != 0 {
		t.Fatalf("comments = %v, want []", body["comments"])
	}
}

func TestListCommentsOldestFirst(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	agent := "period-plans/claude"
	// 写入顺序与时间顺序相反：列表必须按 createdAt 排序。
	h.seedComment(itemID, "First", nil, fixtureTime+86400)
	h.seedComment(itemID, "Second", &agent, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	comments := body["comments"].([]any)
	if len(comments) != 2 {
		t.Fatalf("comments = %v", comments)
	}
	assertField(t, "first content", comments[0].(map[string]any)["content"], "Second")
	assertField(t, "first author", comments[0].(map[string]any)["author"], "period-plans/claude")
	assertField(t, "second content", comments[1].(map[string]any)["content"], "First")
	if comments[1].(map[string]any)["author"] != nil {
		t.Fatalf("second author = %v, want null", comments[1].(map[string]any)["author"])
	}
}

func TestListCommentsExcludesOtherItems(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	otherPlan := h.seedPlan("week", "2026-10-19", "2026-10-25", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Ship the feature"})
	otherID := h.seedItem(itemSeed{planID: otherPlan, text: "Ship the feature"})
	h.seedComment(itemID, "Mine", nil, fixtureTime)
	h.seedComment(otherID, "Theirs", nil, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	comments := body["comments"].([]any)
	if len(comments) != 1 {
		t.Fatalf("comments = %v", comments)
	}
	assertField(t, "content", comments[0].(map[string]any)["content"], "Mine")
}

func TestListCommentsAggregatesChainWithSourcePeriods(t *testing.T) {
	h := newHarness(t)
	original := h.seedItem(itemSeed{
		planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Original task",
	})
	successor := h.seedItem(itemSeed{
		planID: h.seedPlan("week", "2026-10-19", "2026-10-25", nil),
		text:   "Original task", deferredFromID: &original,
	})
	agent := "period-plans/claude"
	h.seedComment(successor, "Successor follow-up", nil, fixtureTime+3600)
	h.seedComment(original, "Original blocker", &agent, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", successor), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "commentCount", body["commentCount"], 2)
	comments := body["comments"].([]any)
	if len(comments) != 2 {
		t.Fatalf("comments = %v", comments)
	}
	first := comments[0].(map[string]any)
	assertField(t, "first content", first["content"], "Original blocker")
	assertField(t, "first planItemId", first["planItemId"], original)
	firstPeriod := first["sourcePeriod"].(map[string]any)
	assertField(t, "first scope", firstPeriod["scope"], "week")
	assertField(t, "first periodStart", firstPeriod["periodStart"], "2026-10-12")
	assertField(t, "first periodEnd", firstPeriod["periodEnd"], "2026-10-18")
	assertField(t, "first label", firstPeriod["label"], "Week 2026-10-12 - 2026-10-18")

	second := comments[1].(map[string]any)
	assertField(t, "second planItemId", second["planItemId"], successor)
	assertField(t, "second label", second["sourcePeriod"].(map[string]any)["label"], "Week 2026-10-19 - 2026-10-25")
}

func TestListCommentsKeepsCommentsPinnedToOriginal(t *testing.T) {
	h := newHarness(t)
	original := h.seedItem(itemSeed{
		planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Original task",
	})
	successor := h.seedItem(itemSeed{
		planID: h.seedPlan("week", "2026-10-19", "2026-10-25", nil),
		text:   "Original task", deferredFromID: &original,
	})
	h.seedComment(original, "Original note", nil, fixtureTime)
	h.seedComment(successor, "Successor note", nil, fixtureTime+3600)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", original), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "commentCount", body["commentCount"], 1)
	comments := body["comments"].([]any)
	if len(comments) != 1 {
		t.Fatalf("comments = %v", comments)
	}
	assertField(t, "content", comments[0].(map[string]any)["content"], "Original note")
	assertField(t, "label", comments[0].(map[string]any)["sourcePeriod"].(map[string]any)["label"],
		"Week 2026-10-12 - 2026-10-18")
}

func TestListCommentsLabelsMonthPeriods(t *testing.T) {
	h := newHarness(t)
	original := h.seedItem(itemSeed{
		planID: h.seedPlan("month", "2026-09-01", "2026-09-30", ptr("2026-09")), text: "Ship the feature",
	})
	successor := h.seedItem(itemSeed{
		planID: h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10")),
		text:   "Ship the feature", deferredFromID: &original,
	})
	h.seedComment(original, "September decision", nil, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", successor), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "commentCount", body["commentCount"], 1)
	period := body["comments"].([]any)[0].(map[string]any)["sourcePeriod"].(map[string]any)
	assertField(t, "scope", period["scope"], "month")
	assertField(t, "monthKey", period["monthKey"], "2026-09")
	assertField(t, "label", period["label"], "Month 2026-09")
}

func TestCreateCommentRejectsNonNumericID(t *testing.T) {
	h := newHarness(t)

	status, _ := decode(t, h.do(http.MethodPost, "/api/plan-items/nope/comments", `{"content":"hello"}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
}

func TestCreateCommentReturns404WhenItemMissing(t *testing.T) {
	h := newHarness(t)

	status, _ := decode(t, h.do(http.MethodPost, "/api/plan-items/999/comments", `{"content":"hello"}`, ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
}

func TestCreateCommentRejectsBlankContent(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, _ := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID), `{"content":"   "}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
}

func TestCreateCommentRejectsMissingContent(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, _ := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID), `{}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
}

func TestCreateBrowserCommentTrimsAndStoresNullAuthor(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID),
		`{"content":"  blocked on review  "}`, ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "content", body["content"], "blocked on review")
	if body["author"] != nil {
		t.Fatalf("author = %v, want null", body["author"])
	}
	assertField(t, "planItemId", body["planItemId"], itemID)

	listStatus, listBody := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", itemID), "", ""))
	if listStatus != http.StatusOK {
		t.Fatalf("status = %d", listStatus)
	}
	comments := listBody["comments"].([]any)
	if len(comments) != 1 || comments[0].(map[string]any)["content"] != "blocked on review" {
		t.Fatalf("comments = %v", comments)
	}
}

// newPAT 在已装配的库里签一个 PAT，返回明文 token。
func (h *harness) newPAT(name string) string {
	h.t.Helper()

	created, err := auth.CreatePAT(context.Background(), h.conn, name, nil)
	if err != nil {
		h.t.Fatalf("create PAT: %v", err)
	}
	return created.Token
}

func TestCreateCommentStoresAgentIdentityForPAT(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	token := h.newPAT("period-plans-skill")

	req := newJSONRequest(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID), `{"content":"defer analysis"}`)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Weekly-Reporter-Agent", "period-plans/claude-code")

	status, body := decode(t, h.doRequest(req))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "author", body["author"], "period-plans/claude-code")
}

func TestCreateCommentFallsBackToPATName(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	token := h.newPAT("period-plans-skill")

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID),
		`{"content":"review conclusion"}`, token))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "author", body["author"], "period-plans-skill")
}

func TestCreateCommentParsesCitationsOnceAtWrite(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, _ := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID),
		`{"content":"blocked by @17 and @17 again — see %42 #review"}`, ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}

	rows, err := h.sqlDB.Query(`SELECT referenced_event_id FROM comment_references`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var eventIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		eventIDs = append(eventIDs, id)
	}
	// `%42` 与 `#review` 在评论里是纯文本（ADR-0024）。
	if len(eventIDs) != 1 || eventIDs[0] != 17 {
		t.Fatalf("comment references = %v, want [17]", eventIDs)
	}
}

func TestCreateCommentDoesNotReparseOnRead(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	if status, _ := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID),
		`{"content":"blocked by @17"}`, "")); status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	if status, _ := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/comments", itemID), "", "")); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM comment_references`); got != 1 {
		t.Fatalf("comment references = %d", got)
	}
}

func TestCreateCommentAcceptsDanglingCitation(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, _ := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/comments", itemID),
		`{"content":"was motivated by @999"}`, ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}

	var referencedEventID int64
	if err := h.sqlDB.QueryRow(`SELECT referenced_event_id FROM comment_references`).Scan(&referencedEventID); err != nil {
		t.Fatal(err)
	}
	if referencedEventID != 999 {
		t.Fatalf("referenced event = %d, want 999", referencedEventID)
	}
}

// 评论是仅追加的：PUT / PATCH 一律落到 /api 通配的 404（没有对应 handler）。
func TestCommentsRejectUpdateMethods(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	for _, method := range []string{http.MethodPut, http.MethodPatch} {
		status, _ := decode(t, h.do(method, fmt.Sprintf("/api/plan-items/%d/comments", itemID), `{"content":"x"}`, ""))
		if status != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", method, status)
		}
	}
}

func TestDeleteCommentRejectsNonNumericIDs(t *testing.T) {
	h := newHarness(t)

	if status, _ := decode(t, h.do(http.MethodDelete, "/api/plan-items/nope/comments/1", "", "")); status != http.StatusBadRequest {
		t.Fatalf("item id status = %d", status)
	}
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	if status, _ := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d/comments/nope", itemID), "", "")); status != http.StatusBadRequest {
		t.Fatalf("comment id status = %d", status)
	}
}

func TestDeleteCommentReturns404WhenItemMissing(t *testing.T) {
	h := newHarness(t)

	status, _ := decode(t, h.do(http.MethodDelete, "/api/plan-items/999/comments/1", "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
}

func TestDeleteCommentReturns404WhenCommentMissing(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})

	status, _ := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d/comments/999", itemID), "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
}

func TestDeleteCommentRejectsForeignComment(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	otherID := h.seedItem(itemSeed{
		planID: h.seedPlan("week", "2026-10-19", "2026-10-25", nil), text: "Ship the feature",
	})
	commentID := h.seedComment(otherID, "blocked", nil, fixtureTime)

	status, _ := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d/comments/%d", itemID, commentID), "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM plan_item_comments WHERE id = ?`, commentID); got != 1 {
		t.Fatalf("comment rows = %d", got)
	}
}

func TestDeleteCommentRemovesCitations(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	commentID := h.seedComment(itemID, "blocked", nil, fixtureTime)
	survivorID := h.seedComment(itemID, "keep me", nil, fixtureTime)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO comment_references (comment_id, referenced_event_id, created_at) VALUES (?, ?, ?)`,
		commentID, int64(42), fixtureTime,
	); err != nil {
		t.Fatal(err)
	}

	status, body := decode(t, h.do(http.MethodDelete,
		fmt.Sprintf("/api/plan-items/%d/comments/%d", itemID, commentID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)
	if got := h.countRows(`SELECT COUNT(*) FROM comment_references`); got != 0 {
		t.Fatalf("comment references = %d", got)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM plan_item_comments`); got != 1 {
		t.Fatalf("comments = %d", got)
	}
	var remainingID int64
	if err := h.sqlDB.QueryRow(`SELECT id FROM plan_item_comments`).Scan(&remainingID); err != nil {
		t.Fatal(err)
	}
	if remainingID != survivorID {
		t.Fatalf("remaining comment = %d, want %d", remainingID, survivorID)
	}
}

// 单条评论只提供 DELETE：GET/PUT/PATCH 落到 /api 通配 404。
func TestCommentDetailExposesOnlyDelete(t *testing.T) {
	h := newHarness(t)
	itemID := h.seedItem(itemSeed{planID: h.seedPlan("week", "2026-10-12", "2026-10-18", nil), text: "Ship the feature"})
	commentID := h.seedComment(itemID, "blocked", nil, fixtureTime)

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPatch} {
		status, _ := decode(t, h.do(method,
			fmt.Sprintf("/api/plan-items/%d/comments/%d", itemID, commentID), "", ""))
		if status != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", method, status)
		}
	}
}
