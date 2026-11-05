package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/buildinfo"
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
