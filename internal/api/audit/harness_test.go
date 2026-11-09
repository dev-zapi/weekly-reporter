package audit

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// testPassword 与 auth 域夹具同角色：一个密码请求 = 浏览器登录成功（且不写审计，
// 正好用来观察"库里本来有多少行"）。
const testPassword = "test-password"

// harness 装配真实 SQLite + 真实 auth 中间件 + 本域路由，断言跑在生产的
// schema 与中间件链上（ADR-0029 的"同用例集"要求）。
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

	r := chi.NewRouter()
	r.Use(trace.Middleware)
	r.Route("/api", func(r chi.Router) {
		r.Use(auth.Middleware(auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: conn},
		}))
		Mount(r, Deps{Queries: conn})
	})

	return &harness{t: t, router: r, sqlDB: sqlDB, conn: conn}
}

func (h *harness) createPAT(name string) auth.CreatedPAT {
	h.t.Helper()
	created, err := auth.CreatePAT(context.Background(), h.conn, name, nil)
	if err != nil {
		h.t.Fatalf("create PAT %q: %v", name, err)
	}
	return created
}

// seedAudit 直接写一行审计，等价于 TS 用例里对 writeAudit 的调用。用显式
// createdAt 而不是当前时间，才能确定性地测「createdAt desc, id desc」排序。
func (h *harness) seedAudit(patName string, status int64, outcome string, createdAt int64) {
	h.t.Helper()
	agent := "weekly-reporter/claude-code"
	cwd := "/tmp/project"
	userAgent := "node-fetch/1.0"
	if err := h.conn.InsertAuditLog(context.Background(), db.InsertAuditLogParams{
		CreatedAt:     createdAt,
		PatName:       &patName,
		Method:        http.MethodGet,
		ApiPath:       "/api/events",
		Status:        status,
		UserAgent:     &userAgent,
		AgentIdentity: &agent,
		CallerCwd:     &cwd,
		Outcome:       outcome,
	}); err != nil {
		h.t.Fatalf("seed audit row: %v", err)
	}
}

func (h *harness) do(path, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

func (h *harness) auditRowCount() int {
	h.t.Helper()
	var count int
	if err := h.sqlDB.QueryRow("SELECT COUNT(*) FROM api_audit_log").Scan(&count); err != nil {
		h.t.Fatal(err)
	}
	return count
}
