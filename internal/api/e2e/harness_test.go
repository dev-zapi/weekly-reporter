package e2e_test

import (
	"database/sql"
	"encoding/json"
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

// testPassword 与 B1/B2/B5 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite（schema.sql 全量）+
// 真实中间件链 + 本域路由，所以「路由真的挂在 /api 下、且过同一套鉴权」也是断言
// 的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
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

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn}
}

// fixturesEnabled 打开本路由的门控，测试结束自动恢复。
func (h *harness) fixturesEnabled() {
	h.t.Helper()
	h.t.Setenv("E2E_FIXTURES", "1")
}

func (h *harness) do(method, path, body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// authed 发一个带密码的请求。
func (h *harness) authed(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.do(method, path, body, testPassword)
}

// mustAuthed 发请求并要求状态码符合预期；不符合时直接失败并打印 body。
func (h *harness) mustAuthed(method, path, body string, want int) *httptest.ResponseRecorder {
	h.t.Helper()
	rec := h.authed(method, path, body)
	if rec.Code != want {
		h.t.Fatalf("%s %s: status = %d, want %d (body %s)", method, path, rec.Code, want, rec.Body.String())
	}
	return rec
}

// seedReport 直接写一行 reports，作为 report-query 的目标报告。
func (h *harness) seedReport(title, weekStart, weekEnd string) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO reports (title, content, week_start, week_end, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`,
		title, "# "+title, weekStart, weekEnd,
	)
	if err != nil {
		h.t.Fatalf("seed report: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// countRows 返回一条 SELECT COUNT(*) 的结果。
func (h *harness) countRows(query string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.sqlDB.QueryRow(query, args...).Scan(&n); err != nil {
		h.t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// decode 把响应体解析成 map[string]any（数字 = float64，等同 JSON.parse）。
func (h *harness) decode(rec *httptest.ResponseRecorder) map[string]any {
	h.t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		h.t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	return body
}

// number 取响应里的数值字段。
func (h *harness) number(body map[string]any, key string) int64 {
	h.t.Helper()
	value, ok := body[key].(float64)
	if !ok {
		h.t.Fatalf("body[%q] = %#v, want number", key, body[key])
	}
	return int64(value)
}

// numberList 取响应里的数值数组字段。
func (h *harness) numberList(body map[string]any, key string) []int64 {
	h.t.Helper()
	raw, ok := body[key].([]any)
	if !ok {
		h.t.Fatalf("body[%q] = %#v, want array", key, body[key])
	}
	out := make([]int64, 0, len(raw))
	for _, item := range raw {
		value, ok := item.(float64)
		if !ok {
			h.t.Fatalf("body[%q] has non-number element %#v", key, item)
		}
		out = append(out, int64(value))
	}
	return out
}
