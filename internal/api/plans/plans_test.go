package plans_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// decode 把响应体解成 map；断言失败时带上原始 body，便于定位。
func decode(t *testing.T, rec interface {
	Result() *http.Response
}) (int, map[string]any) {
	t.Helper()
	res := rec.Result()
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return res.StatusCode, body
}

func items(t *testing.T, body map[string]any) []map[string]any {
	t.Helper()
	raw, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("items is not an array: %v", body["items"])
	}
	out := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		out = append(out, entry.(map[string]any))
	}
	return out
}

func texts(t *testing.T, rows []map[string]any) []string {
	t.Helper()
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row["text"].(string))
	}
	return out
}

func TestPlansRequiresScope(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans", "", ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if !stringsContains(body["error"], "scope") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestPlansRejectsInvalidScope(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=invalid", "", ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "scope") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestPlansWeekWithoutPlanIsEmpty(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["plan"] != nil {
		t.Fatalf("plan = %v, want null", body["plan"])
	}
	if len(items(t, body)) != 0 {
		t.Fatalf("items = %v", body["items"])
	}
}

func TestPlansWeekReturnsPlanWithItems(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: planID, text: "Task 1", position: 1})
	h.seedItem(itemSeed{planID: planID, text: "Task 2", status: "done", projectScope: "personal", position: 2})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	plan := body["plan"].(map[string]any)
	if plan["scope"] != "week" || plan["periodStart"] != "2026-10-12" || plan["periodEnd"] != "2026-10-18" {
		t.Fatalf("plan = %v", plan)
	}
	rows := items(t, body)
	if len(rows) != 2 || rows[0]["text"] != "Task 1" || rows[1]["text"] != "Task 2" {
		t.Fatalf("items = %v", rows)
	}
}

func TestPlansIncludesFulfillmentCount(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	item1 := h.seedItem(itemSeed{planID: planID, text: "Task 1", position: 1})
	item2 := h.seedItem(itemSeed{planID: planID, text: "Task 2", status: "done", projectScope: "personal", position: 2})

	e1 := h.seedEvent("Did work %1", "manual", fixtureTime)
	e2 := h.seedEvent("More work %1", "manual", fixtureTime)
	e3 := h.seedEvent("Work on %2", "manual", fixtureTime)
	h.seedPlanReference(e1, item1)
	h.seedPlanReference(e2, item1)
	h.seedPlanReference(e3, item2)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	rows := items(t, body)
	if rows[0]["fulfillmentCount"].(float64) != 2 || rows[1]["fulfillmentCount"].(float64) != 1 {
		t.Fatalf("fulfillment counts = %v / %v", rows[0]["fulfillmentCount"], rows[1]["fulfillmentCount"])
	}
}

func TestPlansQueriesByWeekStartAndEnd(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t,
		h.do(http.MethodGet, "/api/plans?scope=week&weekStart=2026-10-12&weekEnd=2026-10-18", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

func TestPlansCanonicalizesNonMondayWeekStart(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	// 周三 2026-10-14 .. 周二 2026-10-20（不始于周一的原始区间）必须解析到规范周。
	status, body := decode(t,
		h.do(http.MethodGet, "/api/plans?scope=week&weekStart=2026-10-14&weekEnd=2026-10-20", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

func TestPlansWeekRejectsInvalidDateFormat(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-13-01", "", ""))
	// DATE_REGEX 通过，但 new Date(...) 是 Invalid Date：date-fns 的 format 抛错 → 500。
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["code"] != "FETCH_ERROR" {
		t.Fatalf("code = %v", body["code"])
	}
}

func TestPlansWeekRequiresDateOrWeekPair(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week", "", ""))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "date") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestPlansMonthByKey(t *testing.T) {
	h := newHarness(t)
	h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&month=2026-10", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	plan := body["plan"].(map[string]any)
	if plan["scope"] != "month" || plan["monthKey"] != "2026-10" {
		t.Fatalf("plan = %v", plan)
	}
}

func TestPlansMonthByDate(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=month&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

func TestPlansSortsItemsByPosition(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: planID, text: "Third", position: 3})
	h.seedItem(itemSeed{planID: planID, text: "First", position: 1})
	h.seedItem(itemSeed{planID: planID, text: "Second", position: 2})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	got := texts(t, items(t, body))
	want := []string{"First", "Second", "Third"}
	if !equalStrings(got, want) {
		t.Fatalf("texts = %v, want %v", got, want)
	}
}

func TestPlansGroupsByPriorityThenPosition(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: planID, text: "Low first", priority: "low", position: 1})
	h.seedItem(itemSeed{planID: planID, text: "Normal second", priority: "normal", position: 2})
	h.seedItem(itemSeed{planID: planID, text: "High third", priority: "high", position: 3})
	h.seedItem(itemSeed{planID: planID, text: "High first", priority: "high", position: 1})
	h.seedItem(itemSeed{planID: planID, text: "Normal first", priority: "normal", position: 1})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	got := texts(t, items(t, body))
	want := []string{"High first", "High third", "Normal first", "Normal second", "Low first"}
	if !equalStrings(got, want) {
		t.Fatalf("texts = %v, want %v", got, want)
	}
}

func TestPlansQuadrantFlagsDoNotAffectOrdering(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: planID, text: "Low but flagged", priority: "low", isImportant: true, isUrgent: true, position: 1})
	h.seedItem(itemSeed{planID: planID, text: "High unflagged", priority: "high", position: 2})
	h.seedItem(itemSeed{planID: planID, text: "Normal flagged", priority: "normal", isImportant: true, position: 3})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	rows := items(t, body)
	got := texts(t, rows)
	want := []string{"High unflagged", "Normal flagged", "Low but flagged"}
	if !equalStrings(got, want) {
		t.Fatalf("texts = %v, want %v", got, want)
	}
	if rows[2]["isImportant"] != true || rows[2]["isUrgent"] != true {
		t.Fatalf("flags = %v", rows[2])
	}
	if rows[0]["isImportant"] != false {
		t.Fatalf("flags = %v", rows[0])
	}
}

func TestPlansIncludesCommentCount(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	withComments := h.seedItem(itemSeed{planID: planID, text: "Has context", position: 1})
	h.seedItem(itemSeed{planID: planID, text: "No context", position: 2})

	h.seedComment(withComments, "first", nil, fixtureTime)
	h.seedComment(withComments, "second", ptr("agent"), fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	rows := items(t, body)
	if rows[0]["commentCount"].(float64) != 2 || rows[1]["commentCount"].(float64) != 0 {
		t.Fatalf("comment counts = %v / %v", rows[0]["commentCount"], rows[1]["commentCount"])
	}
}

func TestPlansAggregatesCommentCountsAcrossDeferralChain(t *testing.T) {
	h := newHarness(t)
	previousPlan := h.seedPlan("week", "2026-10-05", "2026-10-11", nil)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	original := h.seedItem(itemSeed{planID: previousPlan, text: "Deferred task", status: "deferred"})
	successor := h.seedItem(itemSeed{planID: planID, text: "Deferred task", deferredFromID: ptr(original)})

	h.seedComment(original, "ancestor note", nil, fixtureTime)
	h.seedComment(successor, "successor note", nil, fixtureTime)

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	rows := items(t, body)
	if len(rows) != 1 || rows[0]["id"].(float64) != float64(successor) {
		t.Fatalf("items = %v", rows)
	}
	if rows[0]["commentCount"].(float64) != 2 {
		t.Fatalf("commentCount = %v", rows[0]["commentCount"])
	}
}

func TestPlansWeekShapeHasNoMonthKeys(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	h.seedItem(itemSeed{planID: planID, text: "Task 1"})

	status, body := decode(t, h.do(http.MethodGet, "/api/plans?scope=week&date=2026-10-15", "", ""))
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if _, present := body["attachCandidates"]; present {
		t.Fatalf("week response must not carry attachCandidates")
	}
	rows := items(t, body)
	for _, key := range []string{"childItems", "directFulfillmentCount", "indirectFulfillmentCount"} {
		if _, present := rows[0][key]; present {
			t.Fatalf("week item must not carry %s", key)
		}
	}
	for _, key := range []string{"fulfillmentCount", "commentCount"} {
		if _, present := rows[0][key]; !present {
			t.Fatalf("week item must carry %s", key)
		}
	}
}

func ptr[T any](v T) *T { return &v }

func stringsContains(v any, sub string) bool {
	s, ok := v.(string)
	return ok && contains(s, sub)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
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
