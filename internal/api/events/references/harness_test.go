// 本包是 GET /api/events/{id}/references 的 Go 实现与 httptest 同用例集（ADR-0029）。
// 测试走生产路由 api.NewRouter：本域把 "/events/{id}/references" 扁平注册在 /api 下，
// 与同批的 "/events" / "/events/{id}" / "/events/heatmap" 共存靠 chi 的静态段优先级，
// 挂载本身就是被证明的一部分。
package references_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// 夹具时刻：与 vitest 的 `new Date('2026-10-12T00:00:00.000Z')` 同角色。
const (
	seedEventTime = int64(1_791_795_600) // 2026-10-12T09:00:00Z
	seedCreatedAt = int64(1_791_763_200) // 2026-10-12T00:00:00Z
)

type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	router := api.NewRouter(api.Options{
		Auth:    auth.Options{Disabled: true},
		Queries: db.New(sqlDB),
	})

	return &harness{t: t, router: router, sqlDB: sqlDB}
}

func (h *harness) do(path string) *httptest.ResponseRecorder {
	h.t.Helper()

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// seedEvent 写一条事件并返回 id。
func (h *harness) seedEvent(content string) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, created_at, updated_at) VALUES (?, 'manual', ?, ?, ?)`,
		seedEventTime, content, seedCreatedAt, seedCreatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed event: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatalf("seed event id: %v", err)
	}
	return id
}

// seedReferrer 写一条引用目标事件的 event_references 行（引用方事件本身也写）。
func (h *harness) seedReferrer(targetID int64, content string) int64 {
	h.t.Helper()

	referrerID := h.seedEvent(content)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_references (event_id, referenced_event_id, created_at) VALUES (?, ?, ?)`,
		referrerID, targetID, seedCreatedAt,
	); err != nil {
		h.t.Fatalf("seed event reference: %v", err)
	}
	return referrerID
}

// seedPlanItem 写一个周期计划 + 一个计划条目，返回条目 id。
func (h *harness) seedPlanItem(scope, periodStart, periodEnd string, monthKey *string) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO period_plans (scope, period_start, period_end, month_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		scope, periodStart, periodEnd, monthKey, seedCreatedAt, seedCreatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed plan: %v", err)
	}
	planID, err := res.LastInsertId()
	if err != nil {
		h.t.Fatalf("seed plan id: %v", err)
	}

	res, err = h.sqlDB.Exec(
		`INSERT INTO period_plan_items (period_plan_id, text, position, created_at, updated_at) VALUES (?, 'Ship the feature', 1, ?, ?)`,
		planID, seedCreatedAt, seedCreatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed plan item: %v", err)
	}
	itemID, err := res.LastInsertId()
	if err != nil {
		h.t.Fatalf("seed plan item id: %v", err)
	}
	return itemID
}

// seedCitation 写一条引用目标事件的计划条目评论，返回评论 id。
func (h *harness) seedCitation(planItemID, referencedEventID int64, content string, author *string) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO plan_item_comments (plan_item_id, content, author, created_at) VALUES (?, ?, ?, ?)`,
		planItemID, content, author, seedCreatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed comment: %v", err)
	}
	commentID, err := res.LastInsertId()
	if err != nil {
		h.t.Fatalf("seed comment id: %v", err)
	}

	if _, err := h.sqlDB.Exec(
		`INSERT INTO comment_references (comment_id, referenced_event_id, created_at) VALUES (?, ?, ?)`,
		commentID, referencedEventID, seedCreatedAt,
	); err != nil {
		h.t.Fatalf("seed comment reference: %v", err)
	}
	return commentID
}
