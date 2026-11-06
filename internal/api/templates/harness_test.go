package templates_test

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

// testPassword 与 B1/B2 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite（schema.sql 全量）+
// 真实中间件链 + 本域路由，所以「路由真的挂在 /api 下」也是断言的一部分。
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

// do 发一个请求；body 为空表示无请求体，token 为空表示不带 Authorization 头。
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

// breakDB 关掉底层连接，复现 route.ts 的 catch 分支（500 + *_ERROR）。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}
