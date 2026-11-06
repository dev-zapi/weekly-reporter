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

// B2 的 7 条路由必须真的挂在 /api 子路由上。这里同样用「关认证 + 真实库」的
// 装配验证「路由存在 + 静态段不被 {id} 吃掉 + 没落到通配兜底」。
func TestB2DomainRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/tags", "", http.StatusOK, `"tags":[]`},
		{http.MethodDelete, "/api/tags?name=unknown", "", http.StatusOK, `"removed":0`},
		{http.MethodPost, "/api/tags/rename", `{"from":"工作","to":"任务"}`, http.StatusOK, `"eventsUpdated":0`},
		{http.MethodGet, "/api/snippets", "", http.StatusOK, `"snippets":[]`},
		{http.MethodDelete, "/api/snippets/999", "", http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodGet, "/api/events", "", http.StatusOK, `"events":[]`},
		{http.MethodGet, "/api/events/999", "", http.StatusNotFound, `"error":"Event not found"`},
		{http.MethodPost, "/api/export", `{"content":"x"}`, http.StatusOK, `"variant":"personal"`},
		// /events/heatmap 与 /events/{id}/references 归同批另一张票：本 worktree 里
		// 它们尚未注册，所以这里不断言它们的响应，跨票共存由集成分支验证。
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			var req *http.Request
			if tc.body == "" {
				req = httptest.NewRequest(tc.method, tc.path, nil)
			} else {
				req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.expect) {
				t.Fatalf("body = %s, want it to contain %s", rec.Body.String(), tc.expect)
			}
		})
	}
}

// B3 的计划域路由必须真的挂在 /api 子路由上，且子路由不被 /plan-items/{id} 遮蔽。
func TestB3DomainRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/plans?scope=week", "", http.StatusBadRequest, `"error":"For week scope`},
		{http.MethodGet, "/api/plan-items/999", "", http.StatusNotFound, `"error":"Plan item not found"`},
		{http.MethodGet, "/api/plan-items/999/comments", "", http.StatusNotFound, `"error":"Plan item not found"`},
		{http.MethodGet, "/api/plan-items/999/fulfillment", "", http.StatusNotFound, `"error":"Plan item not found"`},
		{http.MethodPost, "/api/plan-items/999/defer", "", http.StatusNotFound, `"error":"Plan item not found"`},
		{http.MethodDelete, "/api/plan-items/1/comments/2", "", http.StatusNotFound, `"error":"Plan item not found"`},
		{http.MethodPost, "/api/plan-items", `{"text":"x"}`, http.StatusBadRequest, `"error":"Either periodPlanId or scope is required"`},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			var req *http.Request
			if tc.body == "" {
				req = httptest.NewRequest(tc.method, tc.path, nil)
			} else {
				req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.expect) {
				t.Fatalf("body = %s, want it to contain %s", rec.Body.String(), tc.expect)
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

// B4 的采集执行面（本地 Fetch / 远端同步 / 目录扫描）必须真的挂在 /api 子路由上。
// 同批另两张票负责 collect/sources 的 CRUD 与两条增补 POST 路由：它们在本 worktree
// 尚未注册，跨票共存由集成分支验证，这里只断言本票的三条 + 鉴权边界。
func TestB4CollectExecutionRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		// 关认证也照样是业务 400/500，而不是通配的 "Not Found"。
		{http.MethodPost, "/api/collect/git-local/fetch", `{}`, http.StatusBadRequest, `"code":"INVALID_ID"`},
		{http.MethodPost, "/api/collect/git-remote/sync", `{"sourceId":999}`, http.StatusInternalServerError, `"code":"SYNC_FAILED"`},
		{http.MethodGet, "/api/collect/scan-path?path=/etc", "", http.StatusForbidden, `"code":"FORBIDDEN"`},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			var req *http.Request
			if tc.body == "" {
				req = httptest.NewRequest(tc.method, tc.path, nil)
			} else {
				req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.expect) {
				t.Fatalf("body = %s, want it to contain %s", rec.Body.String(), tc.expect)
			}
		})
	}
}
