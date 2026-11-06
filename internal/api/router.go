// Package api 组装 chi 路由与中间件。B0 落地 health 与 SPA 回落骨架，
// 业务域路由从 B1 起按域挂到 /api 下（B1 = 认证与审计域）。
package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	auditapi "github.com/dev-zapi/weekly-reporter/internal/api/audit"
	authapi "github.com/dev-zapi/weekly-reporter/internal/api/auth"
	eventsapi "github.com/dev-zapi/weekly-reporter/internal/api/events"
	heatmapapi "github.com/dev-zapi/weekly-reporter/internal/api/events/heatmap"
	referencesapi "github.com/dev-zapi/weekly-reporter/internal/api/events/references"
	exportapi "github.com/dev-zapi/weekly-reporter/internal/api/export"
	snippetsapi "github.com/dev-zapi/weekly-reporter/internal/api/snippets"
	tagsapi "github.com/dev-zapi/weekly-reporter/internal/api/tags"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/buildinfo"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// Options 是路由装配所需的依赖。SPA 为 nil 时不注册静态回落（测试常用）。
// Queries 是各业务域共用的 sqlc 查询集；serve 必须提供，域路由通过它读写库。
type Options struct {
	Auth    auth.Options
	Queries *db.Queries
	SPA     http.Handler
}

// NewRouter 返回应用路由。
//
// 分层照 ADR-0025：trace 挂全局（静态资源也要 trace 头），auth/audit 只挂 /api；
// health 在 /api 之外，保持探针无需凭证。
func NewRouter(opts Options) http.Handler {
	r := chi.NewRouter()
	r.Use(trace.Middleware)

	r.Get("/health", healthHandler)

	r.Route("/api", func(r chi.Router) {
		r.Use(auth.Middleware(opts.Auth))
		// B1+ 在这里注册各域路由。域内只做业务语义：鉴权、审计、trace 头由上面
		// 的中间件与全局 trace 统一负责。
		authapi.Mount(r, authapi.Deps{Queries: opts.Queries})
		auditapi.Mount(r, auditapi.Deps{Queries: opts.Queries})
		// B2 的基础 CRUD 与导出域。全部用扁平模式注册：静态段（/events/heatmap）
		// 由 chi 原生优先于 /events/{id}，同批另一张票的子路由（/events/{id}/references）
		// 也能与这里的 {id} 共存。
		tagsapi.Mount(r, tagsapi.Deps{Queries: opts.Queries})
		snippetsapi.Mount(r, snippetsapi.Deps{Queries: opts.Queries})
		eventsapi.Mount(r, eventsapi.Deps{Queries: opts.Queries})
		exportapi.Mount(r, exportapi.Deps{})
		heatmapapi.Mount(r, heatmapapi.Deps{Queries: opts.Queries})
		referencesapi.Mount(r, referencesapi.Deps{Queries: opts.Queries})
		// 未注册的 /api 路径也要过鉴权：Next 的 proxy matcher 是 '/api/:path*'，
		// 任何 /api 请求都会被早拒。chi 的子路由只有注册过路由才会构建中间件链
		// （没有路由时 mux.handler 为 nil，直接走 NotFound、绕过 Use），所以这里
		// 必须显式挂一个通配路由，而不是只设 NotFound。
		// 通配路由最后注册、优先级也低于静态路由，不会吃掉上面的域路由。
		r.Handle("/*", http.HandlerFunc(apiNotFound))
	})

	if opts.SPA != nil {
		r.Handle("/*", opts.SPA)
		r.Handle("/", opts.SPA)
	}

	return r
}

// apiNotFound 是 /api 下未注册路径的统一响应。JSON 形状与既有 {error} 约定一致，
// 让客户端不必为「路由写错了」和「业务 404」写两套解析。
func apiNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`{"error":"Not Found"}`))
}

// healthHandler 返回 200 + 构建信息。trace 响应头由全局中间件统一写入，
// 所以这里只关心 body。
func healthHandler(w http.ResponseWriter, r *http.Request) {
	body, err := json.Marshal(struct {
		Status string `json:"status"`
		buildinfo.Info
	}{Status: "ok", Info: buildinfo.Current()})
	if err != nil {
		http.Error(w, `{"error":"Internal"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}
