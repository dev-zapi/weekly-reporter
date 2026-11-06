package snippets

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// testPassword 与 B1 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

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

// seedSnippet 直接写一行 sentence_snippets（时间固定，断言不依赖当前时间）。
func (h *harness) seedSnippet(content, category string, builtIn bool) int64 {
	h.t.Helper()
	builtInInt := 0
	if builtIn {
		builtInInt = 1
	}
	res, err := h.sqlDB.Exec(
		`INSERT INTO sentence_snippets (content, category, is_built_in, created_at, updated_at) VALUES (?, ?, ?, 1700000000, 1700000100)`,
		content, category, builtInInt,
	)
	if err != nil {
		h.t.Fatalf("seed snippet: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

func urlEscape(s string) string {
	return url.QueryEscape(s)
}
