package plans_test

import (
	"fmt"
	"net/http"
	"testing"
)

// POST /api/plan-items 的同用例集，逐条对照 src/app/api/plan-items/route.test.ts。

func TestCreatePlanItemRequiresTarget(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items", `{"text":"Test item"}`, testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "periodPlanId") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemRejectsEmptyText(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":""}`, planID), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "Text") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemRejectsWhitespaceText(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"   "}`, planID), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "Text") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemWithExistingPlan(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Complete feature X","projectScope":"work"}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "text", body["text"], "Complete feature X")
	assertField(t, "status", body["status"], "planned")
	assertField(t, "projectScope", body["projectScope"], "work")
	assertField(t, "periodPlanId", body["periodPlanId"], planID)
	assertField(t, "position", body["position"], 1)
}

func TestCreatePlanItemAcceptsProvidedPriority(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Urgent task","priority":"high"}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "high")
}

func TestCreatePlanItemDefaultsPriorityToNormal(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Normal task"}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "normal")
}

func TestCreatePlanItemRejectsInvalidPriority(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Task","priority":"urgent"}`, planID), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "priority") {
		t.Fatalf("error = %v", body["error"])
	}
	assertField(t, "code", body["code"], "INVALID_PRIORITY")
}

func TestCreatePlanItemDefaultsQuadrantFlagsOff(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Plain task"}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "isImportant", body["isImportant"], false)
	assertField(t, "isUrgent", body["isUrgent"], false)
}

func TestCreatePlanItemWithBothQuadrantFlags(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Quadrant one task","isImportant":true,"isUrgent":true}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "isImportant", body["isImportant"], true)
	assertField(t, "isUrgent", body["isUrgent"], true)
}

func TestCreatePlanItemAcceptsLowPriorityWithBothFlags(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Deferred but important","priority":"low","isImportant":true,"isUrgent":true}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "priority", body["priority"], "low")
	assertField(t, "isImportant", body["isImportant"], true)
	assertField(t, "isUrgent", body["isUrgent"], true)
}

func TestCreatePlanItemRejectsNonBooleanImportant(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Task","isImportant":"yes"}`, planID), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "isImportant") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemRejectsNonBooleanUrgent(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Task","isUrgent":1}`, planID), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "isUrgent") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemDefaultsProjectScopeToWork(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Task"}`, planID), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "projectScope", body["projectScope"], "work")
}

func TestCreatePlanItemAutoIncrementsPosition(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status1, body1 := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Task 1"}`, planID), testPassword))
	if status1 != http.StatusCreated {
		t.Fatalf("status = %d", status1)
	}
	assertField(t, "first position", body1["position"], 1)

	status2, body2 := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Task 2"}`, planID), testPassword))
	if status2 != http.StatusCreated {
		t.Fatalf("status = %d", status2)
	}
	assertField(t, "second position", body2["position"], 2)
}

func TestCreatePlanItemEnsuresWeekPlan(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		`{"scope":"week","weekStart":"2026-10-12T00:00:00+08:00","weekEnd":"2026-10-18T00:00:00+08:00","text":"Task"}`, testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "text", body["text"], "Task")
	if _, present := body["periodPlanId"]; !present {
		t.Fatalf("periodPlanId missing from response")
	}

	if got := h.countRows(`SELECT COUNT(*) FROM period_plans`); got != 1 {
		t.Fatalf("plans = %d", got)
	}
	var scope, start, end string
	if err := h.sqlDB.QueryRow(`SELECT scope, period_start, period_end FROM period_plans`).Scan(&scope, &start, &end); err != nil {
		t.Fatal(err)
	}
	if scope != "week" || start != "2026-10-12" || end != "2026-10-18" {
		t.Fatalf("plan = %s %s %s", scope, start, end)
	}
}

func TestCreatePlanItemEnsuresMonthPlan(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		`{"scope":"month","month":"2026-10-01T00:00:00+08:00","text":"Monthly task"}`, testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	if _, present := body["periodPlanId"]; !present {
		t.Fatalf("periodPlanId missing from response")
	}

	var scope string
	var monthKey *string
	if err := h.sqlDB.QueryRow(`SELECT scope, month_key FROM period_plans`).Scan(&scope, &monthKey); err != nil {
		t.Fatal(err)
	}
	if scope != "month" || monthKey == nil || *monthKey != "2026-10" {
		t.Fatalf("plan = %s %v", scope, monthKey)
	}
}

func TestCreatePlanItemReusesExistingPlan(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		`{"scope":"week","weekStart":"2026-10-12T00:00:00+08:00","weekEnd":"2026-10-18T00:00:00+08:00","text":"Task"}`, testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "periodPlanId", body["periodPlanId"], planID)
	if got := h.countRows(`SELECT COUNT(*) FROM period_plans`); got != 1 {
		t.Fatalf("plans = %d", got)
	}
}

func TestCreatePlanItemAcceptsWeekToMonthParent(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "Monthly goal"})
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Weekly task","parentItemId":%d}`, weekPlan, monthItem), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertField(t, "parentItemId", body["parentItemId"], monthItem)
}

func TestCreatePlanItemRejectsMissingParent(t *testing.T) {
	h := newHarness(t)
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Weekly task","parentItemId":9999}`, weekPlan), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "parentItemId") {
		t.Fatalf("error = %v", body["error"])
	}
}

// route.ts 的 parentItemId 分支先走 validateParentLink 的作用域检查（不查库），
// 所以 month 条目的任何 parentItemId——包括形状错误的——都报作用域错误。
func TestCreatePlanItemMonthScopeRejectsAnyParentFirst(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-10-01", "2026-10-31", ptr("2026-10"))

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Monthly task","parentItemId":"abc"}`, monthPlan), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "error", body["error"], "parentItemId is only allowed on week items")
}

// periodPlanId 的不可绑定真值（布尔/数组/对象）在 route.ts 里是驱动绑定错误 →
// catch → 500 CREATE_ERROR，而不是「计划不存在」的 404。
func TestCreatePlanItemUnbindablePeriodPlanIDIs500(t *testing.T) {
	for _, body := range []string{
		`{"periodPlanId":true,"text":"Task"}`,
		`{"periodPlanId":[1,2],"text":"Task"}`,
		`{"periodPlanId":{"a":1},"text":"Task"}`,
	} {
		t.Run(body, func(t *testing.T) {
			h := newHarness(t)

			status, decoded := decode(t, h.do(http.MethodPost, "/api/plan-items", body, testPassword))
			if status != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500", status)
			}
			assertField(t, "code", decoded["code"], "CREATE_ERROR")
		})
	}
}

func TestCreatePlanItemRejectsNonMonthParent(t *testing.T) {
	h := newHarness(t)
	weekPlan1 := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)
	weekParent := h.seedItem(itemSeed{planID: weekPlan1, text: "Week parent"})
	weekPlan2 := h.seedPlan("week", "2026-10-19", "2026-10-25", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Weekly task","parentItemId":%d}`, weekPlan2, weekParent), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "month") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemRejectsParentOutsideMonth(t *testing.T) {
	h := newHarness(t)
	monthPlan := h.seedPlan("month", "2026-09-01", "2026-09-30", ptr("2026-09"))
	monthItem := h.seedItem(itemSeed{planID: monthPlan, text: "September goal"})
	weekPlan := h.seedPlan("week", "2026-10-12", "2026-10-18", nil)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"periodPlanId":%d,"text":"Weekly task","parentItemId":%d}`, weekPlan, monthItem), testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "parentItemId") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemRejectsUnknownPlan(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		`{"periodPlanId":9999,"text":"Task"}`, testPassword))
	if status != http.StatusNotFound {
		t.Fatalf("status = %d", status)
	}
	if !stringsContains(body["error"], "Period plan not found") {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestCreatePlanItemInvalidJSONIs500(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items", `{"text":`, testPassword))
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d", status)
	}
	assertField(t, "code", body["code"], "CREATE_ERROR")
}
