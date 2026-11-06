package plans_test

import (
	"fmt"
	"net/http"
	"testing"
)

// POST /api/plan-items/{id}/defer 的用例集，逐条对照
// src/app/api/plan-items/[id]/defer/route.test.ts。

func TestDeferReturns404WhenItemMissing(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items/999/defer", "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "not found") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestDeferWeekItemToNextWeek(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Task to defer", status: "in_progress"})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "text", body["text"], "Task to defer")
	assertField(t, "projectScope", body["projectScope"], "work")
	assertField(t, "deferredFromItemId", body["deferredFromItemId"], itemID)
	assertField(t, "status", body["status"], "planned")

	var week2Start, week2End string
	var week2ID int64
	if err := h.sqlDB.QueryRow(
		`SELECT id, period_start, period_end FROM period_plans WHERE id <> ?`, week1,
	).Scan(&week2ID, &week2Start, &week2End); err != nil {
		t.Fatal(err)
	}
	if week2Start != "2026-10-19" || week2End != "2026-10-25" {
		t.Fatalf("next week = %s..%s", week2Start, week2End)
	}
	assertField(t, "periodPlanId", body["periodPlanId"], week2ID)
	if got := h.itemStatus(itemID); got != "deferred" {
		t.Fatalf("original status = %s", got)
	}
}

func TestDeferInheritsPriorityAndFlags(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{
		planID: week1, text: "High priority task", status: "in_progress",
		priority: "high", isImportant: true, isUrgent: true,
	})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "high")
	assertField(t, "isImportant", body["isImportant"], true)
	assertField(t, "isUrgent", body["isUrgent"], true)

	// 原条目保留自己的优先级与标志，只有 status 翻转。
	var priority string
	var important, urgent int64
	var statusColumn string
	if err := h.sqlDB.QueryRow(
		`SELECT priority, is_important, is_urgent, status FROM period_plan_items WHERE id = ?`, itemID,
	).Scan(&priority, &important, &urgent, &statusColumn); err != nil {
		t.Fatal(err)
	}
	if priority != "high" || important != 1 || urgent != 1 || statusColumn != "deferred" {
		t.Fatalf("original = %s %d %d %s", priority, important, urgent, statusColumn)
	}
}

func TestDeferKeepsDefaultPriorityAndFlags(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Default task"})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "normal")
	assertField(t, "isImportant", body["isImportant"], false)
	assertField(t, "isUrgent", body["isUrgent"], false)
}

func TestDeferMonthItemToNextMonth(t *testing.T) {
	h := newHarness(t)
	month1 := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	itemID := h.seedItem(itemSeed{
		planID: month1, text: "Monthly task to defer", status: "in_progress", projectScope: "personal",
	})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "text", body["text"], "Monthly task to defer")
	assertField(t, "projectScope", body["projectScope"], "personal")
	assertField(t, "deferredFromItemId", body["deferredFromItemId"], itemID)

	var month2ID int64
	var monthKey *string
	if err := h.sqlDB.QueryRow(
		`SELECT id, month_key FROM period_plans WHERE id <> ?`, month1,
	).Scan(&month2ID, &monthKey); err != nil {
		t.Fatal(err)
	}
	if monthKey == nil || *monthKey != "2026-11" {
		t.Fatalf("next month key = %v", monthKey)
	}
	assertField(t, "periodPlanId", body["periodPlanId"], month2ID)
	if got := h.itemStatus(itemID); got != "deferred" {
		t.Fatalf("original status = %s", got)
	}
}

func TestDeferInheritsParentLink(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "Monthly goal"})
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{
		planID: week1, text: "Weekly task", status: "in_progress", parentItemID: &monthItem,
	})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "parentItemId", body["parentItemId"], monthItem)
}

func TestDeferDropsParentLinkOutsideNewMonth(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "October goal"})
	// 周一 2026-10-26（仍在十月）开始的那一周。
	week1 := h.seedPlan("week", "2026-10-26", "2026-11-01", nil)
	itemID := h.seedItem(itemSeed{
		planID: week1, text: "Weekly task", status: "in_progress", parentItemID: &monthItem,
	})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deferredFromItemId", body["deferredFromItemId"], itemID)
	if body["parentItemId"] != nil {
		t.Fatalf("parentItemId = %v, want null", body["parentItemId"])
	}
}

func TestDeferAppendsToEndOfTargetPeriod(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Task to defer", status: "in_progress"})
	week2 := h.seedPlan("week", "2026-10-19", "2026-10-25", nil)
	h.seedItem(itemSeed{planID: week2, text: "Existing task 1", position: 1})
	h.seedItem(itemSeed{planID: week2, text: "Existing task 2", position: 2})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "position", body["position"], 3)
	assertField(t, "periodPlanId", body["periodPlanId"], week2)
}

func TestDeferRejectsAlreadyDeferredItem(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{
		planID: week1, text: "Already deferred task", status: "deferred", deferredFromID: ptr(int64(999)),
	})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "planned or in_progress") {
		t.Fatalf("error = %v", body["error"])
	}
	if got := h.countRows(`SELECT COUNT(*) FROM period_plans`); got != 1 {
		t.Fatalf("plans = %d, want 1", got)
	}
}

func TestDeferRejectsCompletedItem(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Done task", status: "done"})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "planned or in_progress") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestDeferAllowsPlannedItem(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Planned task"})

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "deferredFromItemId", body["deferredFromItemId"], itemID)
}

func TestDeferCreatesNextPeriod(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Task to defer", status: "in_progress"})

	if got := h.countRows(`SELECT COUNT(*) FROM period_plans`); got != 1 {
		t.Fatalf("plans before = %d", got)
	}
	status, _ := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	if got := h.countRows(`SELECT COUNT(*) FROM period_plans`); got != 2 {
		t.Fatalf("plans after = %d", got)
	}
}

func TestDeferLeavesCommentsPinnedToOriginal(t *testing.T) {
	h := newHarness(t)
	week1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: week1, text: "Task with context", status: "in_progress"})
	h.seedComment(itemID, "Blocked on review", nil, fixtureTime)

	status, body := decode(t, h.do(http.MethodPost, fmt.Sprintf("/api/plan-items/%d/defer", itemID), "", ""))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	successor := int64(body["id"].(float64))

	var commentItemID int64
	var content string
	if err := h.sqlDB.QueryRow(`SELECT plan_item_id, content FROM plan_item_comments`).Scan(&commentItemID, &content); err != nil {
		t.Fatal(err)
	}
	if commentItemID != itemID || content != "Blocked on review" {
		t.Fatalf("comment = %d %q", commentItemID, content)
	}
	if commentItemID == successor {
		t.Fatalf("comment moved to the successor")
	}
}
