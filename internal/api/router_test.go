package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/buildinfo"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

func TestHealthCarriesTraceHeaders(t *testing.T) {
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("x-trace-id") == "" || rec.Header().Get("traceparent") == "" {
		t.Fatalf("missing trace headers: %v", rec.Header())
	}
	if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), buildinfo.CommitHash) {
		t.Fatalf("body does not carry build info: %s", rec.Body.String())
	}
}

// 未注册的 /api 路径也必须过鉴权：Next 的 proxy matcher 覆盖整个 /api 前缀，
// 漏鉴权就等于「没写的路由」成了免鉴权洞。
func TestUnknownAPIPathStillRequiresAuth(t *testing.T) {
	router := NewRouter(Options{Auth: auth.Options{Disabled: false, Store: nil}})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/not-registered", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if rec.Header().Get("x-trace-id") == "" {
		t.Fatalf("401 must carry trace headers: %v", rec.Header())
	}
}

func TestUnknownAPIPathAllowsDisabledAuth(t *testing.T) {
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/not-registered", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 with auth disabled", rec.Code)
	}
}

// B1 的 4 条域路由必须真的挂在 /api 子路由上，而且不能被 B0 的 `/api/*`
// 通配兜底吃掉。这里用关闭认证的装配验证"路由存在 + 静态路由优先于通配"：
// 若域路由没挂上，/api/auth/pats 会落到 apiNotFound（body 是 "Not Found"）。
func TestB1DomainRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		want   int
		body   string
	}{
		{http.MethodGet, "/api/auth/verify", http.StatusOK, `"mode":"disabled"`},
		{http.MethodGet, "/api/auth/pats", http.StatusOK, `"pats":[]`},
		{http.MethodGet, "/api/audit", http.StatusOK, `"records":[]`},
		// 关掉认证也照样是业务 404（PAT 不存在），而不是通配的 "Not Found"。
		{http.MethodDelete, "/api/auth/pats/999", http.StatusNotFound, `"code":"NOT_FOUND"`},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.body) {
				t.Fatalf("body = %s, want it to contain %s", rec.Body.String(), tc.body)
			}
		})
	}
}

// 通配兜底本身保持 B0 形状：未注册的 /api 路径仍然回 {error:"Not Found"}。
func TestUnregisteredAPIPathKeepsWildcardBody(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/not-registered", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != `{"error":"Not Found"}` {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
