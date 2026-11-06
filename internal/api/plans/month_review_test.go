package plans_test

import (
	"net/http"
	"testing"
)

// 月度回看（Monthly Review）的完整断言集，逐条对照 src/app/api/plans/route.test.ts
// 的 month-scope aggregation 分组。

func childMap(t *testing.T, item map[string]any) map[int64]map[string]any {
	t.Helper()
	raw, ok := item["childItems"].([]any)
	if !ok {
		t.Fatalf("childItems is not an array: %v", item["childItems"])
	}
	out := make(map[int64]map[string]any, len(raw))
	for _, entry := range raw {
		child := entry.(map[string]any)
		out[int64(child["id"].(float64))] = child
	}
	return out
}

func monthItem(t *testing.T, body map[string]any, index int) map[string]any {
	t.Helper()
	rows := items(t, body)
	if len(rows) <= index {
		t.Fatalf("items = %v, want at least %d", rows, index+1)
	}
	return rows[index]
}

func TestMonthReviewAttachesWeekItemsWithAttribution(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "Goal"})
	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	week5 := h.seedPlan("week", "2026-10-26", "2026-11-01", nil)

	childA := h.seedItem(itemSeed{
		planID: week3, text: "Child A", parentItemID: ptr(goal), status: "done",
		priority: "high", isImportant: true, position: 2,
	})
	childB := h.seedItem(itemSeed{
		planID: week5, text: "Child B", parentItemID: ptr(goal), status: "in_progress",
		projectScope: "personal", priority: "low", isUrgent: true, position: 1,
	})
	orphan := h.seedItem(itemSeed{planID: week3, text: "Orphan", position: 3})

	// childA 有两份证据、childB 一份、orphan 一份（orphan 不该出现在树里）。
	e1 := h.seedEvent("Work 1", "manual", fixtureTime)
	e2 := h.seedEvent("Work 2", "manual", fixtureTime)
	e3 := h.seedEvent("Work 3", "manual", fixtureTime)
	e4 := h.seedEvent("Work 4", "manual", fixtureTime)
	h.seedPlanReference(e1, childA)
	h.seedPlanReference(e2, childA)
	h.seedPlanReference(e3, childB)
	h.seedPlanReference(e4, orphan)
	h.seedComment(childA, "context", nil, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(items(t, body)) != 1 {
		t.Fatalf("items = %v", body["items"])
	}
	item := monthItem(t, body, 0)
	if int64(item["id"].(float64)) != goal {
		t.Fatalf("item id = %v, want %d", item["id"], goal)
	}

	children := childMap(t, item)
	if len(children) != 2 {
		t.Fatalf("childItems = %v", item["childItems"])
	}
	a := children[childA]
	assertField(t, "A id", a["id"], childA)
	assertField(t, "A text", a["text"], "Child A")
	assertField(t, "A status", a["status"], "done")
	assertField(t, "A projectScope", a["projectScope"], "work")
	assertField(t, "A priority", a["priority"], "high")
	assertField(t, "A isImportant", a["isImportant"], true)
	assertField(t, "A isUrgent", a["isUrgent"], false)
	assertField(t, "A weekPeriodStart", a["weekPeriodStart"], "2026-10-12")
	assertField(t, "A weekPeriodEnd", a["weekPeriodEnd"], "2026-10-18")
	assertField(t, "A fulfillmentCount", a["fulfillmentCount"], 2)
	assertField(t, "A commentCount", a["commentCount"], 1)

	b := children[childB]
	assertField(t, "B id", b["id"], childB)
	assertField(t, "B text", b["text"], "Child B")
	assertField(t, "B status", b["status"], "in_progress")
	assertField(t, "B projectScope", b["projectScope"], "personal")
	assertField(t, "B priority", b["priority"], "low")
	assertField(t, "B isImportant", b["isImportant"], false)
	assertField(t, "B isUrgent", b["isUrgent"], true)
	assertField(t, "B weekPeriodStart", b["weekPeriodStart"], "2026-10-26")
	assertField(t, "B weekPeriodEnd", b["weekPeriodEnd"], "2026-11-01")
	assertField(t, "B fulfillmentCount", b["fulfillmentCount"], 1)
	assertField(t, "B commentCount", b["commentCount"], 0)

	if _, present := children[orphan]; present {
		t.Fatalf("orphan item must not appear in the tree")
	}
	groups, ok := item["inheritedChildGroups"].([]any)
	if !ok || len(groups) != 0 {
		t.Fatalf("inheritedChildGroups = %v, want []", item["inheritedChildGroups"])
	}
}

func TestMonthReviewComposesChildCommentCountAcrossChain(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "Goal"})
	week2 := h.seedPlan("week", "2026-10-05", "2026-10-11", nil)
	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	original := h.seedItem(itemSeed{planID: week2, text: "Deferred child", status: "deferred"})
	successor := h.seedItem(itemSeed{
		planID: week3, text: "Deferred child", parentItemID: ptr(goal), deferredFromID: ptr(original),
	})
	unrelated := h.seedItem(itemSeed{planID: week3, text: "Unrelated child", parentItemID: ptr(goal), position: 2})

	h.seedComment(original, "ancestor note", nil, fixtureTime)
	h.seedComment(successor, "successor note", nil, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	children := childMap(t, monthItem(t, body, 0))
	assertField(t, "successor commentCount", children[successor]["commentCount"], 2)
	assertField(t, "unrelated commentCount", children[unrelated]["commentCount"], 0)
}

func TestMonthReviewSeparatesDirectFromIndirectEvidence(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "Goal"})
	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	childA := h.seedItem(itemSeed{planID: week3, text: "Child A", parentItemID: ptr(goal)})
	childB := h.seedItem(itemSeed{planID: week3, text: "Child B", parentItemID: ptr(goal), position: 2})

	// 两个事件直接引用月条目，两个引用 childA，一个引用 childB。
	for i, itemID := range []int64{goal, goal, childA, childA, childB} {
		eventID := h.seedEvent("Work "+string(rune('A'+i)), "manual", fixtureTime+int64(i))
		h.seedPlanReference(eventID, itemID)
	}

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	item := monthItem(t, body, 0)
	assertField(t, "directFulfillmentCount", item["directFulfillmentCount"], 2)
	assertField(t, "indirectFulfillmentCount", item["indirectFulfillmentCount"], 3)
	assertField(t, "fulfillmentCount", item["fulfillmentCount"], 5)
}

func TestMonthReviewCountsSharedEvidenceOnce(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "Goal"})
	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	child := h.seedItem(itemSeed{planID: week3, text: "Child", parentItemID: ptr(goal)})

	// 一份工作同时引用月条目与它的周子项。
	eventID := h.seedEvent("Work", "manual", fixtureTime)
	h.seedPlanReference(eventID, goal)
	h.seedPlanReference(eventID, child)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	item := monthItem(t, body, 0)
	assertField(t, "directFulfillmentCount", item["directFulfillmentCount"], 1)
	assertField(t, "indirectFulfillmentCount", item["indirectFulfillmentCount"], 0)
	assertField(t, "fulfillmentCount", item["fulfillmentCount"], 1)
}

func TestMonthReviewDeduplicatesEvidenceSharedByChainChildren(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "Goal"})
	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	original := h.seedItem(itemSeed{
		planID: week3, text: "Task", parentItemID: ptr(goal), status: "deferred",
	})
	week4 := h.seedPlan("week", "2026-10-19", "2026-10-25", nil)
	h.seedItem(itemSeed{
		planID: week4, text: "Task", parentItemID: ptr(goal), deferredFromID: ptr(original),
	})

	// 一个事件引用原条目；两个子项的链都含它。
	eventID := h.seedEvent("Work", "manual", fixtureTime)
	h.seedPlanReference(eventID, original)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	item := monthItem(t, body, 0)
	rawChildren := item["childItems"].([]any)
	if len(rawChildren) != 2 {
		t.Fatalf("childItems = %v", rawChildren)
	}
	for _, entry := range rawChildren {
		assertField(t, "per-child fulfillmentCount", entry.(map[string]any)["fulfillmentCount"], 1)
	}
	assertField(t, "directFulfillmentCount", item["directFulfillmentCount"], 0)
	assertField(t, "indirectFulfillmentCount", item["indirectFulfillmentCount"], 1)
	assertField(t, "fulfillmentCount", item["fulfillmentCount"], 1)
}

func TestMonthReviewMirrorsDeferralByAggregatingAncestorChildren(t *testing.T) {
	h := newHarness(t)
	septemberPlan := h.seedPlan("month", "2026-09-01", "2026-09-30", ptr("2026-09"))
	ancestor := h.seedItem(itemSeed{planID: septemberPlan, text: "Ancestor goal"})
	// 九月开头的周归属九月，不归十月。
	septemberWeek := h.seedPlan("week", "2026-09-07", "2026-09-13", nil)
	ancestorChild := h.seedItem(itemSeed{
		planID: septemberWeek, text: "Ancestor child", parentItemID: ptr(ancestor),
	})

	octoberPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	successor := h.seedItem(itemSeed{planID: octoberPlan, text: "Ancestor goal", deferredFromID: ptr(ancestor)})
	octoberWeek := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	successorChild := h.seedItem(itemSeed{
		planID: octoberWeek, text: "Successor child", parentItemID: ptr(successor),
	})

	for i, itemID := range []int64{ancestor, successor, ancestorChild, ancestorChild, successorChild} {
		eventID := h.seedEvent("Work "+string(rune('A'+i)), "manual", fixtureTime+int64(i))
		h.seedPlanReference(eventID, itemID)
	}

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(items(t, body)) != 1 {
		t.Fatalf("items = %v", body["items"])
	}
	item := monthItem(t, body, 0)
	assertField(t, "item id", item["id"], successor)
	// 直接聚合顺延链（后继 + 祖先）。
	assertField(t, "directFulfillmentCount", item["directFulfillmentCount"], 2)
	// 间接聚合后继自己的子项加祖先的子项。
	assertField(t, "indirectFulfillmentCount", item["indirectFulfillmentCount"], 3)
	assertField(t, "fulfillmentCount", item["fulfillmentCount"], 5)

	// 只有后继自己的子项出现在它的子树里；祖先的子项以带标签的只读分组暴露。
	rawChildren := item["childItems"].([]any)
	if len(rawChildren) != 1 || int64(rawChildren[0].(map[string]any)["id"].(float64)) != successorChild {
		t.Fatalf("childItems = %v", rawChildren)
	}
	rawGroups := item["inheritedChildGroups"].([]any)
	if len(rawGroups) != 1 {
		t.Fatalf("inheritedChildGroups = %v", rawGroups)
	}
	group := rawGroups[0].(map[string]any)
	assertField(t, "ancestorItemId", group["ancestorItemId"], ancestor)
	assertField(t, "ancestorMonth", group["ancestorMonth"], "2026-09")

	groupItems := group["items"].([]any)
	if len(groupItems) != 1 {
		t.Fatalf("group items = %v", groupItems)
	}
	entry := groupItems[0].(map[string]any)
	assertField(t, "group child id", entry["id"], ancestorChild)
	assertField(t, "group child text", entry["text"], "Ancestor child")
	assertField(t, "group child weekPeriodStart", entry["weekPeriodStart"], "2026-09-07")
	assertField(t, "group child weekPeriodEnd", entry["weekPeriodEnd"], "2026-09-13")
	assertField(t, "group child fulfillmentCount", entry["fulfillmentCount"], 2)
}

func TestMonthReviewAggregatesNestedAncestorChains(t *testing.T) {
	h := newHarness(t)
	// 月顺延链：八月根 → 九月祖先 → 十月后继。
	augustPlan := h.seedPlan("month", "2026-08-01", "2026-08-31", ptr("2026-08"))
	ancestorRoot := h.seedItem(itemSeed{planID: augustPlan, text: "Root goal", status: "deferred"})
	septemberPlan := h.seedPlan("month", "2026-09-01", "2026-09-30", ptr("2026-09"))
	ancestor := h.seedItem(itemSeed{
		planID: septemberPlan, text: "Root goal", status: "deferred", deferredFromID: ptr(ancestorRoot),
	})
	octoberPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	successor := h.seedItem(itemSeed{planID: octoberPlan, text: "Root goal", deferredFromID: ptr(ancestor)})

	// 每个祖先保留自己挂的子项；什么都不迁移。
	augustWeek := h.seedPlan("week", "2026-08-10", "2026-08-16", nil)
	rootChild := h.seedItem(itemSeed{planID: augustWeek, text: "Root child", parentItemID: ptr(ancestorRoot)})
	septemberWeek := h.seedPlan("week", "2026-09-07", "2026-09-13", nil)
	// 九月的子项自己还有一条周顺延前身。
	predecessorWeek := h.seedPlan("week", "2026-08-31", "2026-09-06", nil)
	childPredecessor := h.seedItem(itemSeed{planID: predecessorWeek, text: "Ancestor child"})
	ancestorChild := h.seedItem(itemSeed{
		planID: septemberWeek, text: "Ancestor child", parentItemID: ptr(ancestor),
		deferredFromID: ptr(childPredecessor),
	})
	octoberWeek := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	successorChild := h.seedItem(itemSeed{
		planID: octoberWeek, text: "Successor child", parentItemID: ptr(successor),
	})

	for i, itemID := range []int64{
		ancestorRoot, ancestor, successor, rootChild, ancestorChild, ancestorChild,
		childPredecessor, successorChild,
	} {
		eventID := h.seedEvent("Work "+string(rune('A'+i)), "manual", fixtureTime+int64(i))
		h.seedPlanReference(eventID, itemID)
	}

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(items(t, body)) != 1 {
		t.Fatalf("items = %v", body["items"])
	}
	item := monthItem(t, body, 0)
	assertField(t, "item id", item["id"], successor)
	// 直接：后继及其链上的每一个祖先月条目。
	assertField(t, "directFulfillmentCount", item["directFulfillmentCount"], 3)
	// 间接：经根的子项 1 个，经祖先子项 3 个（自己 2 + 它的周顺延前身 1），经自己的子项 1 个。
	assertField(t, "indirectFulfillmentCount", item["indirectFulfillmentCount"], 5)
	assertField(t, "fulfillmentCount", item["fulfillmentCount"], 8)

	rawChildren := item["childItems"].([]any)
	if len(rawChildren) != 1 || int64(rawChildren[0].(map[string]any)["id"].(float64)) != successorChild {
		t.Fatalf("childItems = %v", rawChildren)
	}

	rawGroups := item["inheritedChildGroups"].([]any)
	months := make([]any, 0, len(rawGroups))
	ancestorIDs := make([]any, 0, len(rawGroups))
	for _, entry := range rawGroups {
		group := entry.(map[string]any)
		months = append(months, group["ancestorMonth"])
		ancestorIDs = append(ancestorIDs, group["ancestorItemId"])
	}
	// 两个祖先月都出现，最近的祖先在前。
	if !equalAny(months, []any{"2026-09", "2026-08"}) {
		t.Fatalf("ancestor months = %v", months)
	}
	if !equalAny(ancestorIDs, []any{float64(ancestor), float64(ancestorRoot)}) {
		t.Fatalf("ancestor ids = %v", ancestorIDs)
	}

	firstGroupItems := rawGroups[0].(map[string]any)["items"].([]any)
	if len(firstGroupItems) != 1 || int64(firstGroupItems[0].(map[string]any)["id"].(float64)) != ancestorChild {
		t.Fatalf("first group items = %v", firstGroupItems)
	}
	secondGroupItems := rawGroups[1].(map[string]any)["items"].([]any)
	if len(secondGroupItems) != 1 || int64(secondGroupItems[0].(map[string]any)["id"].(float64)) != rootChild {
		t.Fatalf("second group items = %v", secondGroupItems)
	}
}

func TestMonthReviewKeepsDeferredItemAndChildrenInPlace(t *testing.T) {
	h := newHarness(t)
	septemberPlan := h.seedPlan("month", "2026-09-01", "2026-09-30", ptr("2026-09"))
	original := h.seedItem(itemSeed{planID: septemberPlan, text: "Kept goal", status: "deferred"})
	septemberWeek := h.seedPlan("week", "2026-09-07", "2026-09-13", nil)
	child := h.seedItem(itemSeed{planID: septemberWeek, text: "Still attached", parentItemID: ptr(original)})
	octoberPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	successor := h.seedItem(itemSeed{planID: octoberPlan, text: "Kept goal", deferredFromID: ptr(original)})

	event1 := h.seedEvent("Work 1", "manual", fixtureTime)
	event2 := h.seedEvent("Work 2", "manual", fixtureTime)
	h.seedPlanReference(event1, child)
	h.seedPlanReference(event2, child)

	septemberStatus, septemberBody := decode(t,
		h.do(http.MethodGet, "/api/plans?scope=month&month=2026-09", "", testPassword))
	if septemberStatus != http.StatusOK {
		t.Fatalf("status = %d", septemberStatus)
	}
	if len(items(t, septemberBody)) != 1 {
		t.Fatalf("items = %v", septemberBody["items"])
	}
	originalItem := monthItem(t, septemberBody, 0)
	assertField(t, "original id", originalItem["id"], original)
	// 顺延后原条目仍然拥有它的子项。
	originalChildren := originalItem["childItems"].([]any)
	if len(originalChildren) != 1 || int64(originalChildren[0].(map[string]any)["id"].(float64)) != child {
		t.Fatalf("original childItems = %v", originalChildren)
	}
	assertField(t, "original indirect", originalItem["indirectFulfillmentCount"], 2)

	octoberStatus, octoberBody := decode(t,
		h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if octoberStatus != http.StatusOK {
		t.Fatalf("status = %d", octoberStatus)
	}
	if len(items(t, octoberBody)) != 1 {
		t.Fatalf("items = %v", octoberBody["items"])
	}
	successorItem := monthItem(t, octoberBody, 0)
	assertField(t, "successor id", successorItem["id"], successor)
	// 什么都不迁移：后继没有自己的子项，但它仍带着祖先子项的证据，并以继承分组暴露。
	successorChildren := successorItem["childItems"].([]any)
	if len(successorChildren) != 0 {
		t.Fatalf("successor childItems = %v", successorChildren)
	}
	groups := successorItem["inheritedChildGroups"].([]any)
	if len(groups) != 1 {
		t.Fatalf("inheritedChildGroups = %v", groups)
	}
	group := groups[0].(map[string]any)
	assertField(t, "ancestorItemId", group["ancestorItemId"], original)
	assertField(t, "ancestorMonth", group["ancestorMonth"], "2026-09")
	groupItems := group["items"].([]any)
	if len(groupItems) != 1 || int64(groupItems[0].(map[string]any)["id"].(float64)) != child {
		t.Fatalf("inherited items = %v", groupItems)
	}
	assertField(t, "successor direct", successorItem["directFulfillmentCount"], 0)
	assertField(t, "successor indirect", successorItem["indirectFulfillmentCount"], 2)
	assertField(t, "successor total", successorItem["fulfillmentCount"], 2)
}

func TestMonthReviewGroupsAttachCandidatesByWeek(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "Goal"})

	// 九月开头的周归属九月。
	septemberWeek := h.seedPlan("week", "2026-09-28", "2026-10-04", nil)
	h.seedItem(itemSeed{planID: septemberWeek, text: "September orphan"})

	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: week3, text: "Normal late", priority: "normal", position: 5})
	h.seedItem(itemSeed{planID: week3, text: "High late", priority: "high", position: 1})
	h.seedItem(itemSeed{planID: week3, text: "Attached item", parentItemID: ptr(goal), position: 2})

	week5 := h.seedPlan("week", "2026-10-26", "2026-11-01", nil)
	h.seedItem(itemSeed{planID: week5, text: "Low week5", priority: "low", position: 1})

	// 十一月开头的周绝不能出现在十月的候选里。
	novemberWeek := h.seedPlan("week", "2026-11-02", "2026-11-08", nil)
	h.seedItem(itemSeed{planID: novemberWeek, text: "November orphan"})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	rawGroups, ok := body["attachCandidates"].([]any)
	if !ok || len(rawGroups) != 2 {
		t.Fatalf("attachCandidates = %v", body["attachCandidates"])
	}
	starts := make([]any, 0, len(rawGroups))
	for _, entry := range rawGroups {
		starts = append(starts, entry.(map[string]any)["periodStart"])
	}
	if !equalAny(starts, []any{"2026-10-12", "2026-10-26"}) {
		t.Fatalf("candidate weeks = %v", starts)
	}

	first := rawGroups[0].(map[string]any)
	assertField(t, "first periodStart", first["periodStart"], "2026-10-12")
	assertField(t, "first periodEnd", first["periodEnd"], "2026-10-18")
	firstTexts := make([]any, 0)
	for _, entry := range first["items"].([]any) {
		firstTexts = append(firstTexts, entry.(map[string]any)["text"])
	}
	if !equalAny(firstTexts, []any{"High late", "Normal late"}) {
		t.Fatalf("first group items = %v", firstTexts)
	}

	second := rawGroups[1].(map[string]any)
	secondTexts := make([]any, 0)
	for _, entry := range second["items"].([]any) {
		secondTexts = append(secondTexts, entry.(map[string]any)["text"])
	}
	if !equalAny(secondTexts, []any{"Low week5"}) {
		t.Fatalf("second group items = %v", secondTexts)
	}
}

func TestMonthReviewOrdersItemsAndChildrenByPriorityGroupThenPosition(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	h.seedItem(itemSeed{planID: monthPlan, text: "Normal p1", priority: "normal", position: 1})
	h.seedItem(itemSeed{planID: monthPlan, text: "High p3", priority: "high", position: 3})
	h.seedItem(itemSeed{planID: monthPlan, text: "Low p1", priority: "low", position: 1})
	goal := h.seedItem(itemSeed{planID: monthPlan, text: "High p1", priority: "high", position: 1})

	week3 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: week3, text: "Normal c1", parentItemID: ptr(goal), priority: "normal", position: 1})
	week5 := h.seedPlan("week", "2026-10-26", "2026-11-01", nil)
	h.seedItem(itemSeed{planID: week5, text: "High c4", parentItemID: ptr(goal), priority: "high", position: 4})
	h.seedItem(itemSeed{planID: week5, text: "High c2", parentItemID: ptr(goal), priority: "high", position: 2})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if got := texts(t, items(t, body)); !equalStrings(got, []string{"High p1", "High p3", "Normal p1", "Low p1"}) {
		t.Fatalf("month item order = %v", got)
	}
	var goalItem map[string]any
	for _, row := range items(t, body) {
		if int64(row["id"].(float64)) == goal {
			goalItem = row
		}
	}
	if goalItem == nil {
		t.Fatalf("goal item missing from response")
	}
	childTexts := make([]string, 0)
	for _, entry := range goalItem["childItems"].([]any) {
		childTexts = append(childTexts, entry.(map[string]any)["text"].(string))
	}
	if !equalStrings(childTexts, []string{"High c2", "High c4", "Normal c1"}) {
		t.Fatalf("child order = %v", childTexts)
	}
}

func TestMonthReviewEmptyWhenNoPlanOrWeeksExist(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["plan"] != nil {
		t.Fatalf("plan = %v, want null", body["plan"])
	}
	if len(items(t, body)) != 0 {
		t.Fatalf("items = %v", body["items"])
	}
	candidates, ok := body["attachCandidates"].([]any)
	if !ok || len(candidates) != 0 {
		t.Fatalf("attachCandidates = %v, want []", body["attachCandidates"])
	}
}

// assertField 比较 JSON 解出来的值（float64 / string / bool / nil）。
func assertField(t *testing.T, label string, got, want any) {
	t.Helper()

	switch expected := want.(type) {
	case int64:
		actual, ok := got.(float64)
		if !ok || int64(actual) != expected {
			t.Fatalf("%s = %v, want %d", label, got, expected)
		}
	case int:
		actual, ok := got.(float64)
		if !ok || int(actual) != expected {
			t.Fatalf("%s = %v, want %d", label, got, expected)
		}
	default:
		if got != expected {
			t.Fatalf("%s = %v, want %v", label, got, expected)
		}
	}
}

func equalAny(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
