package plans_test

import (
	"fmt"
	"net/http"
	"testing"
)

// /api/plan-items/{id} 的 GET/PUT/DELETE 用例集，逐条对照
// src/app/api/plan-items/[id]/route.test.ts。

func TestGetPlanItemReturns404WhenMissing(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plan-items/999", "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "not found") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestGetPlanItemReturnsItem(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Test item"})

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "id", body["id"], itemID)
	assertField(t, "text", body["text"], "Test item")
}

func TestGetPlanItemReturnsPeriodAndDeferralChain(t *testing.T) {
	h := newHarness(t)
	plan1 := h.seedPlan("week", "2026-10-05", "2026-10-11", nil)
	plan2 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	plan3 := h.seedPlan("week", "2026-10-19", "2026-10-25", nil)

	// 顺延链：30 -> 20 -> 10。
	item10 := h.seedItem(itemSeed{planID: plan1, text: "Original", status: "deferred"})
	item20 := h.seedItem(itemSeed{planID: plan2, text: "Deferred once", status: "deferred", deferredFromID: &item10})
	item30 := h.seedItem(itemSeed{planID: plan3, text: "Deferred twice", deferredFromID: &item20})

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d", item30), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "id", body["id"], item30)

	period := body["period"].(map[string]any)
	assertField(t, "period id", period["id"], plan3)
	assertField(t, "period scope", period["scope"], "week")
	assertField(t, "period start", period["periodStart"], "2026-10-19")
	assertField(t, "period end", period["periodEnd"], "2026-10-25")

	chain := body["deferralChain"].([]any)
	want := []any{float64(item30), float64(item20), float64(item10)}
	if !equalAny(chain, want) {
		t.Fatalf("deferralChain = %v, want %v", chain, want)
	}
}

func TestGetPlanItemIncludesReferrers(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Referenced item"})
	eventID := h.seedEvent(fmt.Sprintf("Did work on %%%d", itemID), "manual", fixtureTime)
	h.seedPlanReference(eventID, itemID)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	referrers := body["referrers"].([]any)
	if len(referrers) != 1 {
		t.Fatalf("referrers = %v", referrers)
	}
	ref := referrers[0].(map[string]any)
	assertField(t, "referrer id", ref["id"], eventID)
	assertField(t, "referrer content", ref["content"], fmt.Sprintf("Did work on %%%d", itemID))
}

func TestGetPlanItemEmptyReferrers(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Unreferenced item"})

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if referrers, ok := body["referrers"].([]any); !ok || len(referrers) != 0 {
		t.Fatalf("referrers = %v, want []", body["referrers"])
	}
}

func TestUpdatePlanItemReturns404WhenMissing(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPut, "/api/plan-items/999", `{"text":"Updated"}`, ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "not found") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemRejectsEmptyText(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Original"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"text":""}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "Text") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemText(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Original"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"text":"Updated text"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "text", body["text"], "Updated text")
}

func TestUpdatePlanItemStatus(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"status":"done"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "status", body["status"], "done")
}

func TestUpdatePlanItemRejectsInvalidStatus(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"status":"archived"}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "Invalid status") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemPriority(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task", priority: "normal"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"priority":"high"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "high")
	assertField(t, "position", body["position"], 1)
}

func TestUpdatePlanItemKeepsOmittedPriority(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task", priority: "low"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"text":"Updated text"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "low")
}

func TestUpdatePlanItemRejectsInvalidPriority(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"priority":"urgent"}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "priority") {
		t.Fatalf("error = %v", body["error"])
	}
	assertField(t, "code", body["code"], "INVALID_PRIORITY")
}

func TestUpdatePlanItemQuadrantFlagsIndependently(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task", isImportant: true})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID),
		`{"isImportant":false,"isUrgent":true}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "isImportant", body["isImportant"], false)
	assertField(t, "isUrgent", body["isUrgent"], true)
	assertField(t, "priority", body["priority"], "normal")
}

func TestUpdatePlanItemKeepsOmittedFlags(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{
		planID: planID, text: "Task", priority: "low", isImportant: true, isUrgent: true,
	})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"text":"Updated text"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "text", body["text"], "Updated text")
	assertField(t, "isImportant", body["isImportant"], true)
	assertField(t, "isUrgent", body["isUrgent"], true)
	assertField(t, "priority", body["priority"], "low")
}

func TestUpdatePlanItemRejectsNonBooleanImportant(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"isImportant":"yes"}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "isImportant") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemRejectsNullUrgent(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"isUrgent":null}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "isUrgent") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemProjectScope(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"projectScope":"personal"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "projectScope", body["projectScope"], "personal")
}

func TestUpdatePlanItemPosition(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID), `{"position":5}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "position", body["position"], 5)
}

func TestUpdatePlanItemParentLink(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "Monthly goal"})
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	weekItem := h.seedItem(itemSeed{planID: weekPlan, text: "Weekly task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", weekItem),
		fmt.Sprintf(`{"parentItemId":%d}`, monthItem), ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "parentItemId", body["parentItemId"], monthItem)
}

func TestUpdatePlanItemRejectsMissingParent(t *testing.T) {
	h := newHarness(t)
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	weekItem := h.seedItem(itemSeed{planID: weekPlan, text: "Weekly task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", weekItem), `{"parentItemId":9999}`, ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "parentItemId") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemRejectsNonMonthParent(t *testing.T) {
	h := newHarness(t)
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	weekParent := h.seedItem(itemSeed{planID: weekPlan, text: "Week parent"})
	weekItem := h.seedItem(itemSeed{planID: weekPlan, text: "Weekly task", position: 2})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", weekItem),
		fmt.Sprintf(`{"parentItemId":%d}`, weekParent), ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "month") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemRejectsParentOutsideMonth(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-09-01", "2026-09-30", ptr("2026-09"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "September goal"})
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	weekItem := h.seedItem(itemSeed{planID: weekPlan, text: "Weekly task"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", weekItem),
		fmt.Sprintf(`{"parentItemId":%d}`, monthItem), ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "parentItemId") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestUpdatePlanItemClearsParentWithNull(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "Monthly goal"})
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	weekItem := h.seedItem(itemSeed{planID: weekPlan, text: "Weekly task", parentItemID: &monthItem})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", weekItem), `{"parentItemId":null}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["parentItemId"] != nil {
		t.Fatalf("parentItemId = %v, want null", body["parentItemId"])
	}
}

func TestUpdatePlanItemMultipleFields(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Original"})

	status, body := decode(t, h.do(http.MethodPut, fmt.Sprintf("/api/plan-items/%d", itemID),
		`{"text":"Updated","status":"in_progress","projectScope":"personal"}`, ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "text", body["text"], "Updated")
	assertField(t, "status", body["status"], "in_progress")
	assertField(t, "projectScope", body["projectScope"], "personal")
}

func TestDeletePlanItemReturns404WhenMissing(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodDelete, "/api/plan-items/999", "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "not found") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestDeletePlanItem(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "To delete"})

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)
	if got := h.countRows(`SELECT COUNT(*) FROM period_plan_items`); got != 0 {
		t.Fatalf("items left = %d", got)
	}
}

func TestDeletePlanItemClearsChildParents(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	parent := h.seedItem(itemSeed{planID: monthPlan, text: "Monthly goal"})
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	child := h.seedItem(itemSeed{planID: weekPlan, text: "Weekly task", parentItemID: &parent})

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", parent), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)

	var remaining int64
	var parentLink *int64
	if err := h.sqlDB.QueryRow(`SELECT id, parent_item_id FROM period_plan_items`).Scan(&remaining, &parentLink); err != nil {
		t.Fatal(err)
	}
	if remaining != child {
		t.Fatalf("remaining id = %d, want %d", remaining, child)
	}
	if parentLink != nil {
		t.Fatalf("parentItemId = %v, want NULL", *parentLink)
	}
}

func TestDeletePlanItemPreservesDeferralChain(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	original := h.seedItem(itemSeed{planID: planID, text: "Original task", status: "deferred"})
	carried := h.seedItem(itemSeed{planID: planID, text: "Carried task", deferredFromID: &original, position: 2})

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", original), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)

	var id int64
	var deferredFrom *int64
	if err := h.sqlDB.QueryRow(`SELECT id, deferred_from_item_id FROM period_plan_items`).Scan(&id, &deferredFrom); err != nil {
		t.Fatal(err)
	}
	if id != carried {
		t.Fatalf("remaining id = %d, want %d", id, carried)
	}
	if deferredFrom == nil || *deferredFrom != original {
		t.Fatalf("deferredFromItemId = %v, want %d", deferredFrom, original)
	}
}

func TestDeletePlanItemClearsInboundReferences(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Referenced item"})
	content := fmt.Sprintf("Worked on %%%d", itemID)
	eventID := h.seedEvent(content, "manual", fixtureTime)
	h.seedPlanReference(eventID, itemID)

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)

	// 条目与其入库的关联行都清掉；`%id` 文本留在事件内容里（悬挂引用，ADR-0019）。
	if got := h.countRows(`SELECT COUNT(*) FROM period_plan_items`); got != 0 {
		t.Fatalf("items = %d", got)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM event_plan_references`); got != 0 {
		t.Fatalf("references = %d", got)
	}
	var remainingContent string
	if err := h.sqlDB.QueryRow(`SELECT content FROM raw_events`).Scan(&remainingContent); err != nil {
		t.Fatal(err)
	}
	if remainingContent != content {
		t.Fatalf("content = %q, want %q", remainingContent, content)
	}
}

func TestDeletePlanItemReturnsOnlyDeletedFlag(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Unreferenced item"})

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(body) != 1 || body["deleted"] != true {
		t.Fatalf("body = %v, want {deleted: true}", body)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM period_plan_items`); got != 0 {
		t.Fatalf("items = %d", got)
	}
}

func TestDeletePlanItemClearsAllInboundReferences(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Referenced item"})
	e1 := h.seedEvent(fmt.Sprintf("First event %%%d", itemID), "manual", fixtureTime)
	e2 := h.seedEvent(fmt.Sprintf("Second event %%%d", itemID), "manual", fixtureTime+1)
	h.seedPlanReference(e1, itemID)
	h.seedPlanReference(e2, itemID)

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)
	if got := h.countRows(`SELECT COUNT(*) FROM event_plan_references`); got != 0 {
		t.Fatalf("references = %d", got)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM period_plan_items`); got != 0 {
		t.Fatalf("items = %d", got)
	}
}

func TestDeletePlanItemLeavesOtherReferencesIntact(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	item1 := h.seedItem(itemSeed{planID: planID, text: "Deleted item"})
	item2 := h.seedItem(itemSeed{planID: planID, text: "Surviving item", position: 2})
	eventID := h.seedEvent(fmt.Sprintf("Worked on %%%d and %%%d", item1, item2), "manual", fixtureTime)
	h.seedPlanReference(eventID, item1)
	h.seedPlanReference(eventID, item2)

	status, body := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", item1), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deleted", body["deleted"], true)

	if got := h.countRows(`SELECT COUNT(*) FROM event_plan_references`); got != 1 {
		t.Fatalf("references = %d, want 1", got)
	}
	var planItemID int64
	if err := h.sqlDB.QueryRow(`SELECT plan_item_id FROM event_plan_references`).Scan(&planItemID); err != nil {
		t.Fatal(err)
	}
	if planItemID != item2 {
		t.Fatalf("remaining reference = %d, want %d", planItemID, item2)
	}
}

func TestDeletePlanItemCascadesComments(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Item with comments"})
	commentID := h.seedComment(itemID, "plan-side context", nil, fixtureTime)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO comment_references (comment_id, referenced_event_id, created_at) VALUES (?, ?, ?)`,
		commentID, int64(7), fixtureTime,
	); err != nil {
		t.Fatal(err)
	}

	status, _ := decode(t, h.do(http.MethodDelete, fmt.Sprintf("/api/plan-items/%d", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM plan_item_comments`); got != 0 {
		t.Fatalf("comments = %d", got)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM comment_references`); got != 0 {
		t.Fatalf("comment references = %d", got)
	}
}
