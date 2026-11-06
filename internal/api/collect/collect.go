// Package collect 把采集域的 git 执行面路由挂到 chi 的 /api 子路由上：
// git-local 手动 Fetch、git-remote 同步与目录补全扫描。行为逐条对照
// src/app/api/collect/{git-local/fetch,git-remote/sync,scan-path}/route.ts，
// 服务端逻辑移植自 src/lib/collect/（git 执行、同步引擎、路径展开、白名单）。
//
// 同批的另外两张票分别负责 collect/sources 的 CRUD 与两条增补 POST 路由；
// 三条路由都扁平注册在 /api/collect 之下，互不遮蔽。
package collect

import (
	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把采集执行面注册到 /api 子路由上：
//
//	POST /collect/git-local/fetch
//	POST /collect/git-remote/sync
//	GET  /collect/scan-path
func Mount(r chi.Router, deps Deps) {
	r.Post("/collect/git-local/fetch", gitLocalFetchHandler(deps))
	r.Post("/collect/git-remote/sync", gitRemoteSyncHandler(deps))
	r.Get("/collect/scan-path", scanPathHandler())
}
