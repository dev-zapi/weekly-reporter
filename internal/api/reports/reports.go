// Package reports 把报告域的非生成路由挂到 chi 的 /api 子路由上。
// 行为逐条对照 src/app/api/reports 下的 route.ts，服务端逻辑移植自
// src/lib/reports/{service,source-draft}.ts。
//
// 生成路由（generate / turns / stop / accept / query-snapshots）由同批的引擎票
// 注册，本包只覆盖不触发生成引擎的 8 条路由：
//
//	GET    /reports
//	POST   /reports
//	GET    /reports/{id}
//	PUT    /reports/{id}
//	DELETE /reports/{id}
//	PUT    /reports/{id}/final
//	POST   /reports/{id}/regenerate-source
//	POST   /reports/preview
//	GET    /reports/search
//	GET    /reports/{id}/generation-sessions
//	POST   /reports/{id}/generation-sessions
//	GET    /reports/{id}/generation-sessions/{sessionId}
//	PATCH  /reports/{id}/generation-sessions/{sessionId}
//	DELETE /reports/{id}/generation-sessions/{sessionId}
//
// 静态段 preview / search 由 chi 原生优先于 /reports/{id}；generation-sessions
// 比 /reports/{id} 多一段，按段数与之共存。
package reports

import (
	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把报告域注册到 /api 子路由上。
func Mount(r chi.Router, deps Deps) {
	r.Get("/reports", listReportsHandler(deps))
	r.Post("/reports", createReportHandler(deps))
	r.Post("/reports/preview", previewHandler(deps))
	r.Get("/reports/search", searchHandler(deps))
	r.Get("/reports/{id}", getReportHandler(deps))
	r.Put("/reports/{id}", updateReportHandler(deps))
	r.Delete("/reports/{id}", deleteReportHandler(deps))
	r.Put("/reports/{id}/final", saveFinalHandler(deps))
	r.Post("/reports/{id}/regenerate-source", regenerateSourceHandler(deps))

	// 生成会话的读面 + 新建/改名/归档。轮次与提案的写路径（turns / stop /
	// accept / query-snapshots）由引擎票注册在同一前缀下。
	r.Get("/reports/{id}/generation-sessions", listSessionsHandler(deps))
	r.Post("/reports/{id}/generation-sessions", createSessionHandler(deps))
	r.Get("/reports/{id}/generation-sessions/{sessionId}", getSessionHandler(deps))
	r.Patch("/reports/{id}/generation-sessions/{sessionId}", renameSessionHandler(deps))
	r.Delete("/reports/{id}/generation-sessions/{sessionId}", archiveSessionHandler(deps))
}
