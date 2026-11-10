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

// B4 的两条增补路由必须真的挂在 /api 子路由上（唯一 additive 变更，blueprint
// §2.8）。这里只断言「路由存在 + 200 + 业务对象形状」，不碰文件系统：scan-repos
// 用白名单外的 /etc（业务错误也是 200 + 内嵌 error），batch-add 用空列表。
func TestB4AdditiveRoutesAreMounted(t *testing.T) {
	// 白名单含 $HOME；固定 HOME，确保 /etc 在任何宿主上都落在白名单外。
	t.Setenv("HOME", "/home/test")
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		expect string
	}{
		{http.MethodPost, "/api/collect/scan-repos", `{"basePath":"/etc"}`, `"error":"不允许访问此目录"`},
		{http.MethodPost, "/api/collect/batch-add-sources", `{"repos":[]}`, `"success":true`},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
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

// B4 采集源数据面的 11 个 handler 必须真的挂在 /api 子路由上，且静态段
// （branches/emails/lookup/bulk-*）不被 /collect/sources/{id} 吃掉。
func TestB4CollectSourcesRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/collect/sources", "", http.StatusOK, `"sources":[]`},
		{http.MethodGet, "/api/collect/sources/999", "", http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodGet, "/api/collect/sources/abc", "", http.StatusBadRequest, `"code":"INVALID_ID"`},
		{http.MethodGet, "/api/collect/sources/branches", "", http.StatusOK, `"branches":[]`},
		{http.MethodGet, "/api/collect/sources/emails", "", http.StatusOK, `"authors":[]`},
		{http.MethodGet, "/api/collect/sources/lookup?type=git-local&path=/x", "", http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodPost, "/api/collect/sources/bulk-delete", `{"ids":[]}`, http.StatusBadRequest, `"code":"INVALID_IDS"`},
		{http.MethodPost, "/api/collect/sources/bulk-update-scope", `{"ids":[]}`, http.StatusBadRequest, `"code":"INVALID_IDS"`},
		{http.MethodPost, "/api/collect/sources", `{"type":"nope"}`, http.StatusBadRequest, `"code":"VALIDATION_ERROR"`},
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

// B4 的采集执行面（本地 Fetch / 远端同步 / 目录扫描）必须真的挂在 /api 子路由上。
// 同批另两张票负责 collect/sources 的 CRUD 与两条增补 POST 路由：它们由集成分支
// 一并带入，这里只断言本票的三条 + 鉴权边界。
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

// B5 的模板域路由必须真的挂在 /api 子路由上，且静态段 clone 不被
// /templates/{id} 吃掉、{id}/render 仍可达。
func TestB5TemplateRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/templates", "", http.StatusOK, `"official":`},
		{http.MethodPost, "/api/templates", `{}`, http.StatusBadRequest, `"code":"VALIDATION_ERROR"`},
		{http.MethodGet, "/api/templates/999", "", http.StatusNotFound, `"code":"TEMPLATE_NOT_FOUND"`},
		{http.MethodGet, "/api/templates/999/render", "", http.StatusGone, `"code":"TEMPLATE_RENDER_REMOVED"`},
		{http.MethodPost, "/api/templates/clone", `{}`, http.StatusBadRequest, `"code":"VALIDATION_ERROR"`},
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

// B5 的 prompts 域路由必须真的挂在 /api 子路由上，且 {id} 子路由不被静态段遮蔽。
func TestB5PromptRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/prompts/styles", "", http.StatusOK, `"styles":`},
		{http.MethodGet, "/api/prompts/styles/999", "", http.StatusNotFound, `"code":"STYLE_NOT_FOUND"`},
		{http.MethodGet, "/api/prompts/system", "", http.StatusOK, `"prompts":`},
		{http.MethodPut, "/api/prompts/system", `{"key":"nope","promptText":"x"}`, http.StatusBadRequest, `"error":"Invalid prompt key"`},
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

// B5 的 AI 三个 one-shot 必须真的挂在 /api 子路由上。三条都是 POST，且校验都在
// 风格查询与模型调用之前——所以不用 mock provider 也能断言「路由存在 + 业务 400」
// 而不是被 B0 的 `/api/*` 通配兜底吃掉。
func TestB5AIRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{
			http.MethodPost, "/api/ai/expand-section",
			`{"existingItems":[],"events":[]}`,
			http.StatusBadRequest, `"code":"INVALID_INPUT"`,
		},
		{
			http.MethodPost, "/api/ai/polish-event",
			`{}`,
			http.StatusBadRequest, `"code":"INVALID_INPUT"`,
		},
		{
			http.MethodPost, "/api/ai/unify-style",
			`{}`,
			http.StatusBadRequest, `"code":"INVALID_INPUT"`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
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

// B5 的 settings/ai 配置面必须真的挂在 /api 子路由上：静态段 /settings/ai/models
// 与 /settings/ai/test 不被末段路由 /settings/ai 吃掉，未配置时的业务错误也都
// 落到本域的 {error, code} 而不是通配的 "Not Found"。
func TestB5SettingsRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/settings/ai", "", http.StatusOK, `"configured":false`},
		{http.MethodGet, "/api/settings/ai/models", "", http.StatusBadRequest, `"code":"AI_NOT_CONFIGURED"`},
		// anthropic 协议不探测 provider，所以这条挂载断言不发网络请求。
		{http.MethodPost, "/api/settings/ai/models", `{"protocol":"anthropic","apiUrl":"https://api.anthropic.com","apiKey":"k"}`, http.StatusOK, `"supported":false`},
		{http.MethodPost, "/api/settings/ai/test", "", http.StatusBadRequest, `"code":"AI_NOT_CONFIGURED"`},
		{http.MethodDelete, "/api/settings/ai", "", http.StatusOK, `"configured":false`},
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

// B6 的报告域非生成路由必须真的挂在 /api 子路由上：静态段 preview / search
// 不被 /reports/{id} 吃掉，更长的 generation-sessions 子路由也按段数共存。
// 这里只断言「路由存在 + 业务状态/错误形状」，不碰生成引擎（那 5 条由引擎票
// 注册）。
func TestB6ReportRoutesAreMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		path   string
		body   string
		want   int
		expect string
	}{
		{http.MethodGet, "/api/reports", "", http.StatusOK, `"reports":[]`},
		{http.MethodPost, "/api/reports", `{}`, http.StatusBadRequest, `"code":"VALIDATION_ERROR"`},
		{http.MethodPost, "/api/reports/preview", `{"weekStart":"2024-01-08T00:00:00Z","weekEnd":"2024-01-14T00:00:00Z"}`, http.StatusOK, `"variants":[`},
		{http.MethodGet, "/api/reports/search", "", http.StatusOK, `"reports":[]`},
		{http.MethodGet, "/api/reports/999", "", http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodPut, "/api/reports/999", `{"title":"x"}`, http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodDelete, "/api/reports/999", "", http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodPut, "/api/reports/999/final", `{"variant":"leadership","content":"x"}`, http.StatusNotFound, `"code":"VARIANT_NOT_FOUND"`},
		{http.MethodPost, "/api/reports/999/regenerate-source", "", http.StatusNotFound, `"code":"NOT_FOUND"`},
		{http.MethodGet, "/api/reports/999/generation-sessions", "", http.StatusOK, `"sessions":[]`},
		{http.MethodPost, "/api/reports/999/generation-sessions", `{}`, http.StatusBadRequest, `"code":"INVALID_INPUT"`},
		{http.MethodGet, "/api/reports/999/generation-sessions/1", "", http.StatusNotFound, `"code":"SESSION_NOT_FOUND"`},
		{http.MethodPatch, "/api/reports/999/generation-sessions/1", `{"title":"x"}`, http.StatusNotFound, `"code":"SESSION_NOT_FOUND"`},
		{http.MethodDelete, "/api/reports/999/generation-sessions/1", "", http.StatusNotFound, `"code":"SESSION_NOT_FOUND"`},
		// B6 生成引擎的 5 条路由：路径必须落在域内（业务 400/404），而不是被
		// /api/* 通配兜底成 "Not Found"。
		{http.MethodPost, "/api/reports/999/generate", `{}`, http.StatusBadRequest, `"code":"INVALID_INPUT"`},
		{http.MethodPost, "/api/reports/999/generation-sessions/1/turns", `{}`, http.StatusBadRequest, `"code":"EMPTY_MESSAGE"`},
		{http.MethodPost, "/api/reports/999/generation-sessions/1/turns/1/stop", "", http.StatusNotFound, `"code":"TURN_NOT_FOUND"`},
		{http.MethodPost, "/api/reports/999/generation-sessions/1/proposals/1/accept", "", http.StatusNotFound, `"code":"SESSION_NOT_FOUND"`},
		{http.MethodPost, "/api/reports/999/generation-sessions/1/query-snapshots/refresh", "", http.StatusNotFound, `"code":"SESSION_NOT_FOUND"`},
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

// B6 的 e2e 造数路由必须真的挂在 /api 子路由上，并且鉴权先于 E2E_FIXTURES 门控
// （与 TS 的 withAuth(HOF) 同序）。这里用「关认证」的装配断言路由存在 + 门控语义：
// 未设 E2E_FIXTURES 时回本路由的 {error:"Not found"}（不是通配兜底）。
func TestB6FixturesRouteIsMounted(t *testing.T) {
	queries := db.New(dbtest.New(t))
	router := NewRouter(Options{Auth: auth.Options{Disabled: true}, Queries: queries})

	cases := []struct {
		method string
		body   string
		want   int
		expect string
	}{
		{http.MethodPost, `{"action":"historical","marker":"m"}`, http.StatusNotFound, `"error":"Not found"`},
		{http.MethodDelete, `{"reportIds":[1]}`, http.StatusNotFound, `"error":"Not found"`},
	}
	for _, tc := range cases {
		t.Run(tc.method, func(t *testing.T) {
			t.Setenv("E2E_FIXTURES", "")
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(tc.method, "/api/e2e/fixtures", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(rec, req)

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.expect) {
				t.Fatalf("body = %s, want it to contain %s", rec.Body.String(), tc.expect)
			}
		})
	}

	// 门控打开时同一条路由进入业务分支（historical 回 201）。
	t.Setenv("E2E_FIXTURES", "1")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/e2e/fixtures", strings.NewReader(`{"action":"historical","marker":"m"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
}
