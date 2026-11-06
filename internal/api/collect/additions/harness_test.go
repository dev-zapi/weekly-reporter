package additions_test

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

// testPassword 与 B1/B2/B3 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite + 生产中间件链 +
// 本域路由，挂载本身也是断言的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	// 白名单含 $HOME；固定 HOME 让断言不依赖宿主环境。
	t.Setenv("HOME", filepath.Join(t.TempDir(), "home"))

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

// post 发一个已登录的 POST（密码模式）。空 token 表示不带 Authorization 头，
// 用于断言 401 边界。
func (h *harness) post(path, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.postWithToken(path, body, testPassword)
}

func (h *harness) postWithToken(path, body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// seedSource 直写一行 collect_sources。status / project_scope 走 schema 默认值，
// 与 drizzle 插入时省略这两列的行为一致。
func (h *harness) seedSource(sourceType, name, config string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO collect_sources (type, name, config, created_at, updated_at) VALUES (?, ?, ?, 0, 0)`,
		sourceType, name, config,
	); err != nil {
		h.t.Fatalf("seed collect source: %v", err)
	}
}

func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

// decodeBody 把响应体解成通用对象：断言只依赖 JSON 形状，不依赖结构体字段名。
func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return body
}

// 两条路由都在 withAuth 之后：无凭证必须 401（HTTP 层错误只来自 withAuth/audit）。
func TestAdditiveRoutesRequireAuth(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/api/collect/scan-repos", "/api/collect/batch-add-sources"} {
		t.Run(path, func(t *testing.T) {
			rec := h.postWithToken(path, `{}`, "")
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body.String())
			}
			if strings.TrimSpace(rec.Body.String()) != `{"error":"Unauthorized"}` {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}
