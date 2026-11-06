// Package sources 把采集源数据面（`/api/collect/sources` 及其子路由）挂到 chi 的
// /api 子路由上。行为逐条对照 src/app/api/collect/sources 下的 route.ts；服务端
// 逻辑移植自 src/lib/collect/{paths,realpath,branches,sync-status}.ts 与
// src/lib/validations.ts 的 collectSourceSchema。
//
// 这张票的范围是 sources CRUD + bulk 7 条路由；git 执行面的 fetch/sync/scan 与
// 两条增补 POST 路由由 B4 的另外两张票负责。
package sources

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
	// HTTPClient 是远端 provider（branches / emails）的 fetch 替身；nil = 生产默认
	// （http.DefaultClient）。测试注入打桩实现，避免真的打 GitHub/GitLab。
	HTTPClient func(*http.Request) (*http.Response, error)
}

// httpDo 返回本次请求要用的 fetch 实现。
func (d Deps) httpDo() func(*http.Request) (*http.Response, error) {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return http.DefaultClient.Do
}

// Mount 把采集源数据面注册到 /api 子路由上。
//
// 路由表与 src/app/api/collect/sources 目录一一对应：
//
//	GET    /collect/sources
//	POST   /collect/sources
//	GET    /collect/sources/{id}
//	PUT    /collect/sources/{id}
//	PATCH  /collect/sources/{id}
//	DELETE /collect/sources/{id}
//	GET    /collect/sources/branches
//	GET    /collect/sources/emails
//	GET    /collect/sources/lookup
//	POST   /collect/sources/bulk-delete
//	POST   /collect/sources/bulk-update-scope
//
// chi 的静态段优先于 {id}，所以 branches/emails/lookup/bulk-* 不会被 {id} 吃掉。
func Mount(r chi.Router, deps Deps) {
	r.Get("/collect/sources", listHandler(deps))
	r.Post("/collect/sources", createHandler(deps))
	r.Get("/collect/sources/branches", branchesHandler(deps))
	r.Get("/collect/sources/emails", emailsHandler(deps))
	r.Get("/collect/sources/lookup", lookupHandler(deps))
	r.Post("/collect/sources/bulk-delete", bulkDeleteHandler(deps))
	r.Post("/collect/sources/bulk-update-scope", bulkUpdateScopeHandler(deps))
	r.Get("/collect/sources/{id}", getHandler(deps))
	r.Put("/collect/sources/{id}", putHandler(deps))
	r.Patch("/collect/sources/{id}", patchHandler(deps))
	r.Delete("/collect/sources/{id}", deleteHandler(deps))
}

// sourceJSON 是 collect_sources 一行的响应形状：键名与 drizzle 的属性名一致
// （camelCase），时间列是 Date 经 JSON.stringify 得到的 ISO 字符串，enabled 是
// boolean，config 是「解析后的对象 + token 掩码」。字段顺序照 schema 定义顺序。
type sourceJSON struct {
	ID             int64           `json:"id"`
	Type           string          `json:"type"`
	Name           string          `json:"name"`
	Config         json.RawMessage `json:"config"`
	Enabled        bool            `json:"enabled"`
	Status         *string         `json:"status"`
	ProjectScope   string          `json:"projectScope"`
	LastSyncAt     *string         `json:"lastSyncAt"`
	LastSyncStatus *string         `json:"lastSyncStatus"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

// isoMillis 复刻 `Date.prototype.toISOString()`（UTC、毫秒三位、Z 后缀）。
func isoMillis(sec int64) string {
	return time.Unix(sec, 0).UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

func isoOrNull(sec *int64) *string {
	if sec == nil {
		return nil
	}
	iso := isoMillis(*sec)
	return &iso
}

func boolFromColumn(v int64) bool { return v == 1 }

// toSourceJSON 复刻 drizzle 行 + `{...row, config: {...config, token}}` 的响应形状。
// config 文本非法 JSON 时 drizzle 的 mapFromDriverValue 会抛错 → route.ts 的 catch；
// 调用方把 error 映射成各自路由的 500。
func toSourceJSON(record db.CollectSourceRecord) (sourceJSON, error) {
	masked, err := maskToken(record.Config)
	if err != nil {
		return sourceJSON{}, err
	}
	return sourceJSON{
		ID:             record.ID,
		Type:           record.Type,
		Name:           record.Name,
		Config:         masked,
		Enabled:        boolFromColumn(record.Enabled),
		Status:         record.Status,
		ProjectScope:   record.ProjectScope,
		LastSyncAt:     isoOrNull(record.LastSyncAt),
		LastSyncStatus: record.LastSyncStatus,
		CreatedAt:      isoMillis(record.CreatedAt),
		UpdatedAt:      isoMillis(record.UpdatedAt),
	}, nil
}

// parseIntID 复刻 `parseInt(id)`（无 radix）：NaN → ok=false。
func parseIntID(raw string) (int64, bool) {
	return jsparse.ParseInt(raw)
}

// logAndError 是 handler 里 500 的统一写法（日志 + {error, code}）。
func logAndError(w http.ResponseWriter, message, code string) {
	log.Printf("[API] %s", message)
	respond.Error(w, http.StatusInternalServerError, message, code)
}
