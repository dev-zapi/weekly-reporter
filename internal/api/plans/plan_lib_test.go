package plans

import (
	"context"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// 这些用例对不上任何一条路由：路由层在此之前就 404 早退，所以它们是纯库级
// 语义。原 src/lib/plan-references/{fulfillment,referrers}.test.ts 里的对应
// 用例随票迁到这里（ADR-0029：服务端单测跟着代码走、同批删 vitest 侧）。

// libFixtureTime 与外部测试包的 fixtureTime 同值；两个测试包不能共享常量。
const libFixtureTime int64 = 1_760_000_000

func newLibFixture(t *testing.T) (*db.Queries, func(query string, args ...any) int64) {
	t.Helper()

	sqlDB := dbtest.New(t)
	exec := func(query string, args ...any) int64 {
		t.Helper()
		res, err := sqlDB.Exec(query, args...)
		if err != nil {
			t.Fatalf("exec: %v", err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	return db.New(sqlDB), exec
}

func seedLibPlan(exec func(string, ...any) int64, scope, start, end string) int64 {
	return exec(
		`INSERT INTO period_plans (scope, period_start, period_end, month_key, created_at, updated_at)
		 VALUES (?, ?, ?, NULL, ?, ?)`,
		scope, start, end, libFixtureTime, libFixtureTime,
	)
}

func seedLibItem(exec func(string, ...any) int64, planID int64, text string, deferredFrom *int64) int64 {
	return exec(
		`INSERT INTO period_plan_items
		   (period_plan_id, text, status, priority, is_important, is_urgent,
		    project_scope, parent_item_id, deferred_from_item_id, position, created_at, updated_at)
		 VALUES (?, ?, 'planned', 'normal', 0, 0, 'work', NULL, ?, 1, ?, ?)`,
		planID, text, deferredFrom, libFixtureTime, libFixtureTime,
	)
}

func seedLibEvent(exec func(string, ...any) int64) int64 {
	return exec(
		`INSERT INTO raw_events (event_time, source, content, created_at, updated_at)
		 VALUES (?, 'manual', 'did work', ?, ?)`,
		libFixtureTime, libFixtureTime, libFixtureTime,
	)
}

// 命不中条目时链是空数组（而不是 [0] 或 nil）：route.ts 的 getFulfillmentChain
// 在 first select 返回空时直接 break。
func TestFulfillmentChainOnMissingItemIsEmpty(t *testing.T) {
	conn, _ := newLibFixture(t)

	chain, err := fulfillmentChain(context.Background(), conn, 999)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 0 {
		t.Fatalf("chain = %v, want empty", chain)
	}
}

func TestFulfillmentCountOnMissingItemIsZero(t *testing.T) {
	conn, _ := newLibFixture(t)

	count, err := fulfillmentCount(context.Background(), conn, 999)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("count = %d, want 0", count)
	}
}

func TestFulfillingEventsOnMissingItemIsEmpty(t *testing.T) {
	conn, _ := newLibFixture(t)

	events, err := fulfillingEvents(context.Background(), conn, 999)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want empty", events)
	}
}

// findPlanReferrers 只看直连的那一行：同一条目被多条事件引用时全列出，
// 但不会顺延链聚合，也不串到别的条目。
func TestPlanReferrersScopesToTheGivenItem(t *testing.T) {
	conn, exec := newLibFixture(t)
	planID := seedLibPlan(exec, "week", "2026-10-12", "2026-10-18")
	item1 := seedLibItem(exec, planID, "Item 1", nil)
	item2 := seedLibItem(exec, planID, "Item 2", nil)
	event1 := seedLibEvent(exec)
	event2 := seedLibEvent(exec)
	event3 := seedLibEvent(exec)

	for _, ref := range []struct{ event, item int64 }{
		{event1, item1},
		{event2, item1},
		{event3, item2},
	} {
		exec(`INSERT INTO event_plan_references (event_id, plan_item_id, created_at) VALUES (?, ?, ?)`,
			ref.event, ref.item, libFixtureTime)
	}

	referrers, err := planReferrers(context.Background(), conn, item1)
	if err != nil {
		t.Fatal(err)
	}
	if len(referrers) != 2 {
		t.Fatalf("referrers = %v, want 2", referrers)
	}
	for _, ref := range referrers {
		if ref.ID != event1 && ref.ID != event2 {
			t.Fatalf("referrers = %v, want only %d and %d", referrers, event1, event2)
		}
	}

	empty, err := planReferrers(context.Background(), conn, 999)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("referrers = %v, want empty", empty)
	}
}
