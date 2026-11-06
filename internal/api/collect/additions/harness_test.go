package additions_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite + 生产中间件链 +
// 本域路由，挂载本身也是断言的一部分。鉴权用 Disabled 缩短链路：401 与审计
// 语义由 B1 的 guard 测试覆盖，本域只验业务形状（与 B2/B3 同批约定一致）。
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

	router := api.NewRouter(api.Options{
		Auth:    auth.Options{Disabled: true},
		Queries: conn,
	})

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn}
}

func (h *harness) post(path, body string) *httptest.ResponseRecorder {
	h.t.Helper()

	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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
