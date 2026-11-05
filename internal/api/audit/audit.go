// Package audit 把审计域路由（`GET /api/audit`）挂到 chi 的 /api 子路由上。
// 行为逐条对照 src/app/api/audit/route.ts。
package audit

import (
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把审计域注册到 /api 子路由上。
func Mount(r chi.Router, deps Deps) {
	r.Get("/audit", listHandler(deps))
}

const (
	defaultLimit = int64(50)
	minLimit     = int64(1)
	maxLimit     = int64(200)
)

// record 是响应里的审计行。字段名照 drizzle 行对象的 JS 属性名（camelCase），
// 不是列名——冻结契约以现有响应形状为准。
type record struct {
	ID            int64   `json:"id"`
	CreatedAt     int64   `json:"createdAt"`
	PatName       *string `json:"patName"`
	Method        string  `json:"method"`
	APIPath       string  `json:"apiPath"`
	Status        int64   `json:"status"`
	UserAgent     *string `json:"userAgent"`
	AgentIdentity *string `json:"agentIdentity"`
	CallerCwd     *string `json:"callerCwd"`
	Outcome       string  `json:"outcome"`
}

// listHandler 复刻 route.ts：
//   - patName / status / outcome 为可选过滤，非法值静默忽略；
//   - limit clamp 到 [1,200]，缺省 50；offset 不设上限，缺省 0（负数归 0）；
//   - 排序 createdAt desc, id desc（同毫秒的多行仍按写入顺序倒序）；
//   - 响应 {records, total, limit, offset}。
func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()

		// sqlc 的可空 named arg：nil 表示该条件整体省略，对应 route.ts 里
		// `if (patName) conditions.push(...)` 的动态 WHERE。
		params := db.ListAuditLogsParams{}
		if v := query.Get("patName"); v != "" {
			params.PatName = v
		}
		if v := query.Get("status"); v != "" {
			if n, ok := jsparse.ParseInt(v); ok {
				params.Status = n
			}
		}
		if v := query.Get("outcome"); v == "success" || v == "unauthorized" {
			params.Outcome = v
		}

		limit := int64(defaultLimit)
		if v := query.Get("limit"); v != "" {
			if n, ok := jsparse.ParseInt(v); ok {
				limit = n
			}
		}
		if limit < minLimit {
			limit = minLimit
		}
		if limit > maxLimit {
			limit = maxLimit
		}

		offset := int64(0)
		if v := query.Get("offset"); v != "" {
			if n, ok := jsparse.ParseInt(v); ok {
				offset = n
			}
		}
		if offset < 0 {
			offset = 0
		}

		ctx := r.Context()
		params.Limit = limit
		params.Offset = offset
		rows, err := deps.Queries.ListAuditLogs(ctx, params)
		if err != nil {
			log.Printf("Error fetching audit log: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch audit log", "FETCH_ERROR")
			return
		}

		// total 与 records 用同一套过滤条件；COUNT(*) 与 LIMIT/OFFSET 无关。
		total, err := deps.Queries.CountAuditLogs(ctx, db.CountAuditLogsParams{
			PatName: params.PatName,
			Status:  params.Status,
			Outcome: params.Outcome,
		})
		if err != nil {
			log.Printf("Error fetching audit log: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch audit log", "FETCH_ERROR")
			return
		}

		// 空结果必须是 [] 而不是 null（前端直接 map records）。
		records := make([]record, 0, len(rows))
		for _, row := range rows {
			records = append(records, record{
				ID:            row.ID,
				CreatedAt:     row.CreatedAt,
				PatName:       row.PatName,
				Method:        row.Method,
				APIPath:       row.ApiPath,
				Status:        row.Status,
				UserAgent:     row.UserAgent,
				AgentIdentity: row.AgentIdentity,
				CallerCwd:     row.CallerCwd,
				Outcome:       row.Outcome,
			})
		}

		respond.JSON(w, http.StatusOK, struct {
			Records []record `json:"records"`
			Total   int64    `json:"total"`
			Limit   int64    `json:"limit"`
			Offset  int64    `json:"offset"`
		}{Records: records, Total: total, Limit: limit, Offset: offset})
	}
}
