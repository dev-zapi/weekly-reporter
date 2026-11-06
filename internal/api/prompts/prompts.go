// Package prompts 把提示词管理域路由（`/api/prompts/*`：AI 风格与系统提示词）挂到
// chi 的 /api 子路由上。行为逐条对照 src/app/api/prompts 下的 route.ts，服务端
// 逻辑移植自 src/lib/ai/{styles,seed}.ts（ADR-0005：风格与系统提示词都是数据库
// 实体）。
//
// 域语言照 CONTEXT.md：「提示词管理」指的是 AI 风格与系统提示词；「AI 配置」
// （ai_config 单行：协议格式/API URL/API Key/模型名）是 internal/api/settings
// 的域，两者不混用。
package prompts

import (
	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把提示词管理域注册到 /api 子路由上。
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
