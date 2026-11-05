package apiauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// testPassword 是夹具写进 auth.json 的启动密码；与 vitest 的 'correct-password'
// 同角色：一个密码请求就是"浏览器登录成功"。
const testPassword = "correct-password"

// countingStore 记录中间件对数据面做了什么。
//
// 为什么需要计数：verify 的核心回归点之一是"PAT 只判定一次"——handler 若自己再跑
// 一遍 requireAuth，就会多一次 PAT 查询、多一次 touchPat，并可能与审计行不一致
// （route.ts 的注释即此约束）。TS 侧用 getDb 的 mock 调用次数表达这条断言，Go 侧
// 直接数数据面调用，语义更强。
type countingStore struct {
	inner      auth.Store
	findCalls  int
	touchCalls int
	audits     []auth.AuditRecord
}

func (s *countingStore) FindPAT(ctx context.Context, tokenHash string) (auth.PAT, error) {
	s.findCalls++
	return s.inner.FindPAT(ctx, tokenHash)
}

func (s *countingStore) TouchPAT(ctx context.Context, id int64, atMillis int64) error {
	s.touchCalls++
	return s.inner.TouchPAT(ctx, id, atMillis)
}

func (s *countingStore) WriteAudit(ctx context.Context, rec auth.AuditRecord) error {
	s.audits = append(s.audits, rec)
	return s.inner.WriteAudit(ctx, rec)
}

// harness 是一个装配好的 /api 子路由：真实 SQLite（schema.sql 全量）+ 真实
// auth 中间件（认证开启）+ 本域路由。用真库而不是 mock：本域的验收标准就是
// "同用例集"——同一批断言在同一个 schema 上跑。
type harness struct {
	t      *testing.T
	router http.Handler
	conn   *db.Queries
	store  *countingStore
	cfgDir string
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	conn := db.New(dbtest.New(t))
	store := &countingStore{inner: auth.QueriesStore{Queries: conn}}

	cfgDir := t.TempDir()
	passwordPath := filepath.Join(cfgDir, "auth.json")
	if err := os.WriteFile(passwordPath, []byte(`{"password":"`+testPassword+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// 只装配 /api 子树：全局 trace 中间件保持与生产一致（401 也要带 trace 头），
	// auth 中间件放在域路由之前。
	r := chi.NewRouter()
	r.Use(trace.Middleware)
	r.Route("/api", func(r chi.Router) {
		r.Use(auth.Middleware(auth.Options{PasswordPath: passwordPath, Store: store}))
		Mount(r, Deps{Queries: conn})
	})

	return &harness{t: t, router: r, conn: conn, store: store, cfgDir: cfgDir}
}

// withAuthDisabled 克隆一个 WR_AUTH_DISABLED=1 的装配。
func (h *harness) withAuthDisabled() *harness {
	h.t.Helper()

	passwordPath := filepath.Join(h.cfgDir, "auth.json")
	r := chi.NewRouter()
	r.Use(trace.Middleware)
	r.Route("/api", func(r chi.Router) {
		r.Use(auth.Middleware(auth.Options{Disabled: true, PasswordPath: passwordPath, Store: h.store}))
		Mount(r, Deps{Queries: h.conn})
	})

	clone := *h
	clone.router = r
	return &clone
}

func (h *harness) createPAT(name string, expiresAtMillis *int64) auth.CreatedPAT {
	h.t.Helper()
	created, err := auth.CreatePAT(context.Background(), h.conn, name, expiresAtMillis)
	if err != nil {
		h.t.Fatalf("create PAT %q: %v", name, err)
	}
	return created
}

// do 发一个请求。token 为空表示不带 Authorization 头（未认证）。
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
