package plans_test

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
)

// The plans wire now speaks RFC3339 instants that carry the caller's offset.
// These tests pin the observable contract at the HTTP boundary: date-only and
// bare YYYY-MM are rejected with a format example, and the calendar semantics
// (week alignment, month key) are read from the request's own offset rather
// than the server's timezone.

// wireDate renders a date fixture as the client-offset midnight instant that
// the wire requires (the pinned rule: keep the caller's offset, never fold to
// UTC Z).
func wireDate(date string) string { return date + "T00:00:00+08:00" }

// wireMonth renders a yyyy-MM fixture as its month-start midnight instant.
func wireMonth(month string) string { return month + "-01T00:00:00+08:00" }

// q percent-encodes a wire instant for the query string: a literal '+' would
// decode as a space, so real clients send %2B (URLSearchParams does this).
func q(value string) string { return url.QueryEscape(value) }

// invalidInstantMessage mirrors the events family's 400 template so the wire
// contract reads the same across families.
func invalidInstantMessage(name string) string {
	return "Invalid " + name + ": expected an RFC3339 timestamp with an explicit offset, e.g. 2026-11-03T00:00:00+08:00"
}

// assertInvalidInstant checks both the template message and the family code.
func assertInvalidInstant(t *testing.T, body map[string]any, name, code string) {
	t.Helper()
	assertField(t, "error", body["error"], invalidInstantMessage(name))
	assertField(t, "code", body["code"], code)
}

func TestPlansWeekDateAcceptsOffsetInstant(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-11-02", "2026-11-08", nil)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&date="+q(wireDate("2026-11-03")), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

// A Monday midnight at +08:00 is Sunday 16:00Z. Reading the calendar in UTC
// would align to the previous week; the request offset must win.
func TestPlansWeekAlignsInRequestOffsetNotUTC(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-11-02", "2026-11-08", nil)
	h.seedPlan("week", "2026-10-26", "2026-11-01", nil)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&date="+q("2026-11-02T00:00:00+08:00"), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d (the UTC-shifted previous week must not match)",
			body["plan"].(map[string]any)["id"], planID)
	}
}

func TestPlansWeekPairAcceptsOffsetInstants(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-11-02", "2026-11-08", nil)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&weekStart="+q(wireDate("2026-11-02"))+"&weekEnd="+q(wireDate("2026-11-08")),
		"", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

func TestPlansWeekPairNormalizesWithRequestOffset(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-11-02", "2026-11-08", nil)

	// Wednesday .. Tuesday : must canonicalize to the containing Monday week.
	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&weekStart="+q(wireDate("2026-11-04"))+"&weekEnd="+q(wireDate("2026-11-10")),
		"", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

func TestPlansWeekRejectsDateOnly(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&date=2026-11-03", "", testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "date", "INVALID_DATE")
}

// +08 / +0800 are malformed RFC3339 offsets (±HH:MM is required). They must be
// rejected by the shared wiretime parser rather than silently interpreted.
func TestPlansRejectsMalformedOffsets(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name  string
		query string
		field string
		code  string
	}{
		{
			name:  "short offset on date",
			query: "/api/plans?scope=week&date=" + q("2026-11-03T00:00:00+08"),
			field: "date",
			code:  "INVALID_DATE",
		},
		{
			name:  "compact offset on date",
			query: "/api/plans?scope=week&date=" + q("2026-11-03T00:00:00+0800"),
			field: "date",
			code:  "INVALID_DATE",
		},
		{
			name:  "short offset on weekStart",
			query: "/api/plans?scope=week&weekStart=" + q("2026-11-02T00:00:00+08") + "&weekEnd=" + q(wireDate("2026-11-08")),
			field: "weekStart",
			code:  "INVALID_WEEK_START",
		},
		{
			name:  "compact offset on weekStart",
			query: "/api/plans?scope=week&weekStart=" + q("2026-11-02T00:00:00+0800") + "&weekEnd=" + q(wireDate("2026-11-08")),
			field: "weekStart",
			code:  "INVALID_WEEK_START",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := decode(t, h.do(http.MethodGet, tc.query, "", testPassword))
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %v", status, body)
			}
			assertInvalidInstant(t, body, tc.field, tc.code)
		})
	}
}

func TestPlansWeekRejectsTodayLiteral(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&date=today", "", testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "date", "INVALID_DATE")
}

func TestPlansWeekPairRejectsDateOnly(t *testing.T) {
	h := newHarness(t)

	// weekStart is validated first, so a date-only pair names weekStart.
	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&weekStart=2026-11-02&weekEnd=2026-11-08", "", testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "weekStart", "INVALID_WEEK_START")

	// A bad weekEnd alone is named separately.
	status, body = decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&weekStart="+q(wireDate("2026-11-02"))+"&weekEnd=2026-11-08", "", testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "weekEnd", "INVALID_WEEK_END")
}

func TestPlansMonthRejectsBareKey(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=month&month=2026-11", "", testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "month", "INVALID_MONTH")
}

// 2026-03-01T00:00:00+08:00 is 2026-02-28T16:00Z: a UTC read would derive the
// February key. The request offset must derive March.
func TestPlansMonthDerivesKeyInRequestOffset(t *testing.T) {
	h := newHarness(t)
	h.seedPlan("month", "2026-03-01", "2026-03-31", ptr("2026-03"))

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=month&month="+q("2026-03-01T00:00:00+08:00"), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	plan := body["plan"].(map[string]any)
	if plan["monthKey"] != "2026-03" || plan["periodStart"] != "2026-03-01" || plan["periodEnd"] != "2026-03-31" {
		t.Fatalf("plan = %v", plan)
	}
}

func TestPlansMonthByDateAcceptsOffsetInstant(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("month", "2026-11-01", "2026-11-30", ptr("2026-11"))

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=month&date="+q(wireDate("2026-11-15")), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

// A Sunday midnight at -05:00 stays in that offset's calendar: it belongs to
// the Monday-start week that began six days earlier.
func TestPlansWeekNegativeOffsetSundayAlignsToPreviousWeek(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-10-26", "2026-11-01", nil)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&date="+q("2026-11-01T00:00:00-05:00"), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

// The same negative-offset instant keeps November: its calendar month does not
// drift forward into December.
func TestPlansMonthNegativeOffsetKeepsMonthKey(t *testing.T) {
	h := newHarness(t)
	h.seedPlan("month", "2026-11-01", "2026-11-30", ptr("2026-11"))

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=month&date="+q("2026-11-01T00:00:00-05:00"), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	plan := body["plan"].(map[string]any)
	if plan["monthKey"] != "2026-11" || plan["periodStart"] != "2026-11-01" || plan["periodEnd"] != "2026-11-30" {
		t.Fatalf("plan = %v", plan)
	}
}

// A year-end week spans the year boundary; the keys stay date-only text.
func TestPlansWeekCrossesYearAtYearEnd(t *testing.T) {
	h := newHarness(t)
	planID := h.seedPlan("week", "2026-12-28", "2027-01-03", nil)

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=week&date="+q(wireDate("2026-12-31")), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["plan"].(map[string]any)["id"].(float64) != float64(planID) {
		t.Fatalf("plan id = %v, want %d", body["plan"].(map[string]any)["id"], planID)
	}
}

// An instant late on the last day of December still derives the December key.
func TestPlansMonthCrossesYearAtDecemberEnd(t *testing.T) {
	h := newHarness(t)
	h.seedPlan("month", "2026-12-01", "2026-12-31", ptr("2026-12"))

	status, body := decode(t, h.do(http.MethodGet,
		"/api/plans?scope=month&month="+q("2026-12-31T23:00:00+08:00"), "", testPassword))
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	plan := body["plan"].(map[string]any)
	if plan["monthKey"] != "2026-12" || plan["periodStart"] != "2026-12-01" || plan["periodEnd"] != "2026-12-31" {
		t.Fatalf("plan = %v", plan)
	}
}

func TestCreatePlanItemEnsuresWeekPlanFromOffsetInstants(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"scope":"week","weekStart":%q,"weekEnd":%q,"text":"Task"}`,
			wireDate("2026-11-02"), wireDate("2026-11-08")), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}

	var scope, start, end string
	if err := h.sqlDB.QueryRow(`SELECT scope, period_start, period_end FROM period_plans`).Scan(&scope, &start, &end); err != nil {
		t.Fatal(err)
	}
	if scope != "week" || start != "2026-11-02" || end != "2026-11-08" {
		t.Fatalf("plan = %s %s %s", scope, start, end)
	}
}

func TestCreatePlanItemEnsuresMonthPlanFromOffsetInstant(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		fmt.Sprintf(`{"scope":"month","month":%q,"text":"Monthly task"}`, wireMonth("2026-11")), testPassword))
	if status != http.StatusCreated {
		t.Fatalf("status = %d, body = %v", status, body)
	}

	var scope string
	var monthKey *string
	if err := h.sqlDB.QueryRow(`SELECT scope, month_key FROM period_plans`).Scan(&scope, &monthKey); err != nil {
		t.Fatal(err)
	}
	if scope != "month" || monthKey == nil || *monthKey != "2026-11" {
		t.Fatalf("plan = %s %v", scope, monthKey)
	}
}

func TestCreatePlanItemRejectsDateOnlyWeekParams(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		`{"scope":"week","weekStart":"2026-11-02","weekEnd":"2026-11-08","text":"Task"}`, testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "weekStart", "INVALID_WEEK_START")
}

func TestCreatePlanItemRejectsBareMonth(t *testing.T) {
	h := newHarness(t)

	status, body := decode(t, h.do(http.MethodPost, "/api/plan-items",
		`{"scope":"month","month":"2026-11","text":"Monthly task"}`, testPassword))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	assertInvalidInstant(t, body, "month", "INVALID_MONTH")
}
