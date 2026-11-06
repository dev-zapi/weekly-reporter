// Package templates 把模板域路由（`/api/templates` 及其子路由）挂到 chi 的 /api
// 子路由上。行为逐条对照 src/app/api/templates 下的 route.ts；官方模板种子与
// `src/lib/template/origin-group.ts` 的纯函数一并移植（票 #104「配套移植」）。
package templates

import (
	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把模板域注册到 /api 子路由上。
//
// 路由表与 src/app/api/templates 目录一一对应：
//
//	GET    /templates
//	POST   /templates
//	GET    /templates/{id}
//	PUT    /templates/{id}
//	DELETE /templates/{id}
//	POST   /templates/clone
//	GET    /templates/{id}/render
//
// 静态段 clone 由 chi 原生优先于 /templates/{id}；{id}/render 是更长的子路由，
// 与 /templates/{id} 按段数共存。
func Mount(r chi.Router, deps Deps) {
	r.Get("/templates", listHandler(deps))
	r.Post("/templates", createHandler(deps))
	r.Post("/templates/clone", cloneHandler(deps))
	r.Get("/templates/{id}", getHandler(deps))
	r.Put("/templates/{id}", updateHandler(deps))
	r.Delete("/templates/{id}", deleteHandler(deps))
	r.Get("/templates/{id}/render", renderHandler())
}
