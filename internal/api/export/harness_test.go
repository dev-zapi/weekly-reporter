package export_test

import (
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

// testPassword 与 B1 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter），本域不读库但需要真实中间件链。
type harness struct {
	t      *testing.T
	router http.Handler
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	passwordPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(passwordPath, []byte(`{"password":"`+testPassword+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	router := api.NewRouter(api.Options{
		Auth: auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: db.New(dbtest.New(t))},
		},
		Queries: db.New(dbtest.New(t)),
	})

	return &harness{t: t, router: router}
}

func (h *harness) do(body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(http.MethodPost, "/api/export", nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, "/api/export", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}
