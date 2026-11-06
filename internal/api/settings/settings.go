// Package settings 把 settings/ai 配置面（`/api/settings/ai`、`/models`、`/test`）
// 挂到 chi 的 /api 子路由上。行为逐条对照 src/app/api/settings/ai 下的 route.ts，
// 服务端逻辑移植自 src/lib/ai/config.ts 与 src/lib/ai/provider.ts。
//
// 三协议并存的存量配置（ADR-0027）在本包只做「读写 + 探测」：provider 的
// HTTP 调用先用标准库直连（票面允许），B6 的 internal/aiclient adapter 落地后
// 只换接线，不动本包的 HTTP 契约。
package settings

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
	// HTTPClient 是 provider 探测（模型列表 / 连通测试）的 fetch 替身；nil =
	// 生产默认（http.DefaultClient）。测试注入打桩实现，避免真的打到 provider。
	HTTPClient func(*http.Request) (*http.Response, error)
}

// httpDo 返回本次请求要用的 fetch 实现。
func (d Deps) httpDo() func(*http.Request) (*http.Response, error) {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return http.DefaultClient.Do
}

// Mount 把 settings/ai 配置面注册到 /api 子路由上。
//
// 路由表与 src/app/api/settings/ai 目录一一对应：
//
//	GET    /settings/ai
//	PUT    /settings/ai
//	DELETE /settings/ai
//	GET    /settings/ai/models
//	POST   /settings/ai/models
//	POST   /settings/ai/test
//
// 全部扁平注册：/settings/ai 是末段路由，静态的 /settings/ai/models 与
// /settings/ai/test 不与它冲突（没有 {id} 参数段）。
func Mount(r chi.Router, deps Deps) {
	r.Get("/settings/ai", getConfigHandler(deps))
	r.Put("/settings/ai", putConfigHandler(deps))
	r.Delete("/settings/ai", deleteConfigHandler(deps))
	r.Get("/settings/ai/models", listModelsHandler(deps))
	r.Post("/settings/ai/models", probeModelsHandler(deps))
	r.Post("/settings/ai/test", testConnectionHandler(deps))
}
