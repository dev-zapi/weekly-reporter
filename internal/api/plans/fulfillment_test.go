package plans_test

import (
	"fmt"
	"net/http"
	"testing"
)

// GET /api/plan-items/{id}/fulfillment 的用例集，逐条对照
// src/app/api/plan-items/[id]/fulfillment/route.test.ts。

func TestFulfillmentReturns404WhenItemMissing(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plan-items/999/fulfillment", "", ""))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "not found") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestFulfillmentReturnsEmptyEvents(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Test item"})

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/fulfillment", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if events, ok := body["events"].([]any); !ok || len(events) != 0 {
		t.Fatalf("events = %v, want []", body["events"])
	}
}

func TestFulfillmentReturnsReferencingEvents(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	itemID := h.seedItem(itemSeed{planID: planID, text: "Test item"})

	eventTime1 := int64(1_792_058_400) // 2026-10-15T10:00:00Z
	eventTime2 := int64(1_792_144_800) // 2026-10-16T11:00:00Z
	e1 := h.seedEvent(fmt.Sprintf("Did work %%%d", itemID), "manual", eventTime1)
	e2 := h.seedEvent(fmt.Sprintf("More work %%%d", itemID), "github", eventTime2)
	h.seedPlanReference(e1, itemID)
	h.seedPlanReference(e2, itemID)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/fulfillment", itemID), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	events := body["events"].([]any)
	if len(events) != 2 {
		t.Fatalf("events = %v", events)
	}
	first := events[0].(map[string]any)
	assertField(t, "first id", first["id"], e1)
	assertField(t, "first content", first["content"], fmt.Sprintf("Did work %%%d", itemID))
	assertField(t, "first eventTime", first["eventTime"], "2026-10-15T10:00:00.000Z")
	assertField(t, "first isManual", first["isManual"], true)

	second := events[1].(map[string]any)
	assertField(t, "second id", second["id"], e2)
	assertField(t, "second isManual", second["isManual"], false)
}

func TestFulfillmentAggregatesDeferralChain(t *testing.T) {
	h := newHarness(t)
	plan1 := h.seedPlan("week", "2026-10-05", "2026-10-11", nil)
	plan2 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	plan3 := h.seedPlan("week", "2026-10-19", "2026-10-25", nil)

	// 顺延链：30 -> 20 -> 10。
	item10 := h.seedItem(itemSeed{planID: plan1, text: "Original", status: "deferred"})
	item20 := h.seedItem(itemSeed{planID: plan2, text: "Deferred once", status: "deferred", deferredFromID: &item10})
	item30 := h.seedItem(itemSeed{planID: plan3, text: "Deferred twice", deferredFromID: &item20})

	e1 := h.seedEvent("%10", "manual", 1_792_058_400)
	e2 := h.seedEvent("%20", "manual", 1_792_144_800)
	e3 := h.seedEvent("%30", "manual", 1_792_231_200)
	h.seedPlanReference(e1, item10)
	h.seedPlanReference(e2, item20)
	h.seedPlanReference(e3, item30)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/fulfillment", item30), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	events := body["events"].([]any)
	if len(events) != 3 {
		t.Fatalf("events = %v", events)
	}
}

// 同一个事件引用同一条链上的两个条目时只列一次。
func TestFulfillmentDeduplicatesChainEvidence(t *testing.T) {
	h := newHarness(t)
	plan1 := h.seedPlan("week", "2026-10-05", "2026-10-11", nil)
	plan2 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	original := h.seedItem(itemSeed{planID: plan1, text: "Original", status: "deferred"})
	successor := h.seedItem(itemSeed{planID: plan2, text: "Successor", deferredFromID: &original})

	eventID := h.seedEvent("Work referencing the whole chain", "manual", 1_792_058_400)
	h.seedPlanReference(eventID, original)
	h.seedPlanReference(eventID, successor)

	status, body := decode(t, h.do(http.MethodGet, fmt.Sprintf("/api/plan-items/%d/fulfillment", successor), "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if events := body["events"].([]any); len(events) != 1 {
		t.Fatalf("events = %v, want one deduplicated entry", events)
	}
}
