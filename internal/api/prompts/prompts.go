// Package prompts 把 AI 配置域路由（`/api/prompts/*`）挂到 chi 的 /api 子路由上。
// 行为逐条对照 src/app/api/prompts 下的 route.ts，服务端逻辑移植自
// src/lib/ai/{styles,seed}.ts（ADR-0005：风格与系统提示词都是数据库实体）。
package prompts

import (
	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把 AI 配置域注册到 /api 子路由上。
//
// 路由表与 src/app/api/prompts 目录一一对应：
//
//	GET    /prompts/styles
//	POST   /prompts/styles
//	GET    /prompts/styles/{id}
//	PUT    /prompts/styles/{id}
//	DELETE /prompts/styles/{id}
//	PATCH  /prompts/styles/{id}
//	GET    /prompts/system
//	PUT    /prompts/system
func Mount(r chi.Router, deps Deps) {
	// seeder 对应 TS 的模块级 `seeded` 标志：一个进程（一个 router）只灌一次。
	seeder := &Seeder{}

	r.Get("/prompts/styles", listStylesHandler(deps, seeder))
	r.Post("/prompts/styles", createStyleHandler(deps))
	r.Get("/prompts/styles/{id}", getStyleHandler(deps))
	r.Put("/prompts/styles/{id}", updateStyleHandler(deps))
	r.Delete("/prompts/styles/{id}", deleteStyleHandler(deps))
	r.Patch("/prompts/styles/{id}", setDefaultStyleHandler(deps))
	r.Get("/prompts/system", listSystemPromptsHandler(deps, seeder))
	r.Put("/prompts/system", updateSystemPromptHandler(deps))
}
