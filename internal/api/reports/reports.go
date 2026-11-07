// Package reports 把报告域的全部路由挂到 chi 的 /api 子路由上。
// 行为逐条对照 src/app/api/reports 下的 route.ts，服务端逻辑移植自
// src/lib/reports/{service,source-draft}.ts 与 src/lib/generation/service.ts。
//
// 不触发生成引擎的报告路由：
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
//
// 生成会话的读面与生命周期（列表 / 新建 / 详情 / 改名 / 归档）：
//
//	GET    /reports/{id}/generation-sessions
//	POST   /reports/{id}/generation-sessions
//	GET    /reports/{id}/generation-sessions/{sessionId}
//	PATCH  /reports/{id}/generation-sessions/{sessionId}
//	DELETE /reports/{id}/generation-sessions/{sessionId}
//
// 生成路由（引擎循环在 internal/engine，路由仍由本包注册）：
//
//	POST /reports/{id}/generate
//	POST /reports/{id}/generation-sessions/{sessionId}/turns
//	POST /reports/{id}/generation-sessions/{sessionId}/turns/{turnId}/stop
//	POST /reports/{id}/generation-sessions/{sessionId}/proposals/{proposalId}/accept
//	POST /reports/{id}/generation-sessions/{sessionId}/query-snapshots/refresh
//
// 静态段 preview / search 由 chi 原生优先于 /reports/{id}；generation-sessions
// 比 /reports/{id} 多一段，按段数与之共存。
package reports

import (
	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/engine"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
	// NewStepProvider 只给 httptest 注入生成引擎的 provider；nil = 三协议 adapter。
	NewStepProvider engine.ProviderFactory
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
	r.Post("/reports/{id}/generate", generateReportHandler(deps))

	// 生成会话的读面 + 新建/改名/归档。
	r.Get("/reports/{id}/generation-sessions", listSessionsHandler(deps))
	r.Post("/reports/{id}/generation-sessions", createSessionHandler(deps))
	r.Get("/reports/{id}/generation-sessions/{sessionId}", getSessionHandler(deps))
	r.Patch("/reports/{id}/generation-sessions/{sessionId}", renameSessionHandler(deps))
	r.Delete("/reports/{id}/generation-sessions/{sessionId}", archiveSessionHandler(deps))

	// 生成引擎的写面：一轮 NDJSON 流、停止、接受提案与历史查询刷新。
	generator := engine.New(engine.Options{Queries: deps.Queries, NewProvider: deps.NewStepProvider})
	r.Post("/reports/{id}/generation-sessions/{sessionId}/turns", turnsHandler(deps, generator))
	r.Post("/reports/{id}/generation-sessions/{sessionId}/turns/{turnId}/stop", stopTurnHandler(deps, generator))
	r.Post("/reports/{id}/generation-sessions/{sessionId}/proposals/{proposalId}/accept", acceptProposalHandler(deps))
	r.Post("/reports/{id}/generation-sessions/{sessionId}/query-snapshots/refresh", refreshQuerySnapshotHandler(deps, generator))
}
