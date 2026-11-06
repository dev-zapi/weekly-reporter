// 本包是 GET /api/events/heatmap 的 Go 实现与 httptest 同用例集（ADR-0029）。
// 测试用 api.NewRouter 装配（而不是自己拼一棵 chi 树），因为本域的路由是扁平
// 注册在 /api 下的静态段：挂载本身也是被证明的一部分（/events/heatmap 不能被
// /api/* 通配兜底吃掉）。
package heatmap_test

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

// harness 是装配好的生产路由：真实 SQLite（schema.sql 全量）+ 生产中间件链。
// 认证按 WR_AUTH_DISABLED='1' 关掉——route.ts 的 heatmap 语义与调用者身份无关，
// 本域要验的是查询与聚合。
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

// seedEvent 写一条手动事件，event_time 用给定时刻。
func (h *harness) seedEvent(eventTime int64) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, created_at, updated_at) VALUES (?, 'manual', 'seed', ?, ?)`,
		eventTime, eventTime, eventTime,
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

func (h *harness) do(path string) *httptest.ResponseRecorder {
	h.t.Helper()

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}
