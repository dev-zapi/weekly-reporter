// Package api 组装 chi 路由与中间件。B0 只有 health 与 SPA 回落骨架，
// 业务域路由从 B1 起按域挂到 /api 下。
package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/buildinfo"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// Options 是路由装配所需的依赖。SPA 为 nil 时不注册静态回落（测试常用）。
type Options struct {
	Auth auth.Options
	SPA  http.Handler
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
		// 未注册的 /api 路径也要过鉴权：Next 的 proxy matcher 是 '/api/:path*'，
		// 任何 /api 请求都会被早拒。chi 的子路由只有注册过路由才会构建中间件链
		// （没有路由时 mux.handler 为 nil，直接走 NotFound、绕过 Use），所以这里
		// 必须显式挂一个通配路由，而不是只设 NotFound。
		r.Handle("/*", http.HandlerFunc(apiNotFound))
		// B1+ 在这里注册各域路由；B0 留空。
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
