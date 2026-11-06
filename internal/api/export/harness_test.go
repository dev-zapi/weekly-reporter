package export

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// testPassword 与 B1 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

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

	r := chi.NewRouter()
	r.Use(trace.Middleware)
	r.Route("/api", func(r chi.Router) {
		r.Use(auth.Middleware(auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{},
		}))
		Mount(r, Deps{})
	})

	return &harness{t: t, router: r}
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
