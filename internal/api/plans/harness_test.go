package plans_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// testPassword 与 B1/B2 夹具同角色：一个密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite（schema.sql 全量）+
// 真实中间件链 + 本域路由。用装配后的路由而不是自建子树，挂载本身也是断言的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
	// defaultToken 是认证开启时浏览器面的口令（启动密码）；关闭认证的装配为空。
	// 传空 token 的 do 会带上它，相当于「浏览器登录成功的请求」。
	defaultToken string
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)

	passwordPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(passwordPath, []byte(`{"password":"`+testPassword+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	router := api.NewRouter(api.Options{
		Auth: auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: conn},
		},
		Queries: conn,
	})

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn, defaultToken: testPassword}
}

// newOpenHarness 是关闭认证后的装配：PAT 模式相关的用例自己另建带 token 的请求。
func newOpenHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)
	router := api.NewRouter(api.Options{
		Auth:    auth.Options{Disabled: true},
		Queries: conn,
	})
	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn}
}

// do 发一个请求。body 为空表示无请求体；token 为空表示不带 Authorization 头。
func (h *harness) do(method, path, body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token == "" {
		token = h.defaultToken
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return h.doRequest(req)
}

func (h *harness) doRequest(req *http.Request) *httptest.ResponseRecorder {
	h.t.Helper()
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// newJSONRequest 构造一个带 JSON 体的请求，供需要在 do 之外加自定义头的用例使用。
func newJSONRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

// fixtureTime 是所有夹具的固定时刻（Unix 秒），避免测试依赖当前时间。
const fixtureTime int64 = 1_760_000_000

// seedPlan 写一条 period_plans 行并返回其 id。
func (h *harness) seedPlan(scope, periodStart, periodEnd string, monthKey *string) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO period_plans (scope, period_start, period_end, month_key, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		scope, periodStart, periodEnd, monthKey, fixtureTime, fixtureTime,
	)
	if err != nil {
		h.t.Fatalf("seed plan: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// itemSeed 是 seedItem 的入参；零值等价于 schema 默认值。
type itemSeed struct {
	planID         int64
	text           string
	status         string
	priority       string
	projectScope   string
	parentItemID   *int64
	deferredFromID *int64
	position       int64
	isImportant    bool
	isUrgent       bool
}

func (h *harness) seedItem(seed itemSeed) int64 {
	h.t.Helper()

	status := seed.status
	if status == "" {
		status = "planned"
	}
	priority := seed.priority
	if priority == "" {
		priority = "normal"
	}
	scope := seed.projectScope
	if scope == "" {
		scope = "work"
	}
	position := seed.position
	if position == 0 {
		position = 1
	}

	res, err := h.sqlDB.Exec(
		`INSERT INTO period_plan_items
		   (period_plan_id, text, status, priority, is_important, is_urgent,
		    project_scope, parent_item_id, deferred_from_item_id, position,
		    created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		seed.planID, seed.text, status, priority, boolInt(seed.isImportant), boolInt(seed.isUrgent),
		scope, seed.parentItemID, seed.deferredFromID, position, fixtureTime, fixtureTime,
	)
	if err != nil {
		h.t.Fatalf("seed item: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// seedEvent 写一行 raw_events。
func (h *harness) seedEvent(content, source string, eventTime int64) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		eventTime, source, content, fixtureTime, fixtureTime,
	)
	if err != nil {
		h.t.Fatalf("seed event: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// seedPlanReference 写一条 event_plan_references 行（ADR-0019 的达成关联索引）。
func (h *harness) seedPlanReference(eventID, planItemID int64) {
	h.t.Helper()

	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_plan_references (event_id, plan_item_id, created_at) VALUES (?, ?, ?)`,
		eventID, planItemID, fixtureTime,
	); err != nil {
		h.t.Fatalf("seed plan reference: %v", err)
	}
}

// seedComment 写一条 plan_item_comments 行。
func (h *harness) seedComment(planItemID int64, content string, author *string, createdAt int64) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO plan_item_comments (plan_item_id, content, author, created_at) VALUES (?, ?, ?, ?)`,
		planItemID, content, author, createdAt,
	)
	if err != nil {
		h.t.Fatalf("seed comment: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) countRows(query string, args ...any) int {
	h.t.Helper()

	var n int
	if err := h.sqlDB.QueryRow(query, args...).Scan(&n); err != nil {
		h.t.Fatalf("count rows: %v", err)
	}
	return n
}

func (h *harness) itemStatus(id int64) string {
	h.t.Helper()

	var status string
	if err := h.sqlDB.QueryRow(`SELECT status FROM period_plan_items WHERE id = ?`, id).Scan(&status); err != nil {
		h.t.Fatalf("read item %d: %v", id, err)
	}
	return status
}

// breakDB 关掉底层连接，用来复现 route.ts 的 catch 分支（500 + *_ERROR）。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}
