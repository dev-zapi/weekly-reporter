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
//
// 非数字 limit / offset 走 route.ts 的 NaN 分支，不按默认值处理——票面写明
// 「行为以现有 route.ts 为唯一事实源」，蓝图 §2.1 又冻结了响应形状与状态码：
//
//	parseInt 失败得到 NaN，而 NaN 能穿过 Math.max / Math.min（结果仍是 NaN）；
//	drizzle 的 buildLimit 只在 `limit >= 0` 时拼 LIMIT、offset 只在真值时拼
//	OFFSET，于是 NaN 让对应子句整体消失，JSON.stringify(NaN) 又把回显字段变成
//	null。三个可观测结果（已对 drizzle-orm 0.45.2 + better-sqlite3 复现）：
//
//	?limit=abc          → 200，无 LIMIT（返回全部行），"limit":null
//	?offset=abc         → 200，无 OFFSET，"offset":null
//	?limit=abc&offset=1 → 只剩 "offset 1" 子句，SQLite 语法错误 → 500 FETCH_ERROR
//
// 照抄这个副作用的理由：它是冻结契约的一部分，不是本移植可以顺手「修好」的
// 自由度；要改成默认 50/0 得先改票面与蓝图，属于设计决策而非施工。
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

		limit, limitOK := parseLimit(query.Get("limit"))
		offset, offsetOK, offsetOverflow := parseOffset(query.Get("offset"))

		// route.ts 的非法 SQL 分支：LIMIT 被丢掉但 OFFSET 为真值时，drizzle 拼出的
		// 语句没有 LIMIT 却带 OFFSET，SQLite 直接报语法错误，被 route.ts 的 catch
		// 变成 500 FETCH_ERROR。按同一可观测结果返回，不去执行那条坏语句。
		//
		// offsetOverflow 走同一分支：offset 的数学值 ≥ 2^63-512 时 JS 得到 2^63，
		// 绑进 SQLite 是 datatype mismatch——同一条「坏 SQL → 500」路径。
		if (!limitOK && offsetOK && offset > 0) || offsetOverflow {
			log.Printf("Error fetching audit log: unusable pagination clause (limit ok=%t, offset=%d)", limitOK, offset)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch audit log", "FETCH_ERROR")
			return
		}

		ctx := r.Context()
		// LIMIT -1 在 SQLite 里等价于「不设上限」，正是 NaN 时丢掉 LIMIT 子句的效果；
		// 省略 OFFSET 与 OFFSET 0 等价（NaN 与 0 在 drizzle 里都不拼子句）。
		params.Limit = -1
		if limitOK {
			params.Limit = limit
		}
		params.Offset = 0
		if offsetOK {
			params.Offset = offset
		}
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

		// JSON 回显：NaN 在 JSON.stringify 里变 null，所以 limit/offset 必须可空。
		var limitJSON *int64
		var offsetJSON *float64
		if limitOK {
			limitJSON = &limit
		}
		if offsetOK {
			// route.ts 回显的是 parseInt 的 double 结果，不是精确整数：数学值 ≥ 2^53
			// 时 parseInt 已把它舍入到最近的 double，JSON.stringify 再打该 double 的
			// 最短往返十进制（?offset=9223372036854775295 → "offset":9223372036854775000）。
			// Go 的 encoding/json 对 float64 用同一套最短往返记法（< 1e21 不切指数）
			// 且 |offset| < 2^63 恒在范围内，所以折成 float64 回显即逐字节对等。
			// OFFSET 绑定仍用精确 int64：两者在此量级最多差 1024，结果都是空页，
			// 可观测行集与状态码不变（见 parseOffset 的说明）。
			echo := float64(offset)
			offsetJSON = &echo
		}

		respond.JSON(w, http.StatusOK, struct {
			Records []record `json:"records"`
			Total   int64    `json:"total"`
			Limit   *int64   `json:"limit"`
			Offset  *float64 `json:"offset"`
		}{Records: records, Total: total, Limit: limitJSON, Offset: offsetJSON})
	}
}

// parseLimit 复刻 route.ts 的
//
//	Math.min(Math.max(parseInt(sp.get('limit') || '50'), 1), 200)
//
// ok=false 表示 JS 的 NaN（parseInt 没读到数字）：Math.max / Math.min 不吞 NaN，
// 所以 clamp 在这里必须让位。缺省与空串都走默认值——`|| '50'` 把空串当假值。
func parseLimit(raw string) (int64, bool) {
	if raw == "" {
		return defaultLimit, true
	}
	n, ok := jsparse.ParseInt(raw)
	if !ok {
		return 0, false
	}
	if n < minLimit {
		n = minLimit
	}
	if n > maxLimit {
		n = maxLimit
	}
	return n, true
}

// parseOffset 复刻 `Math.max(parseInt(sp.get('offset') || '0'), 0)`。ok=false 是 NaN；
// overflow 表示 JS 的 double 结果已到 2^63，绑定进 SQLite 必然 datatype mismatch。
// 负向溢出被 Math.max 归 0，不会进 OFFSET 子句，因而不报 overflow。
//
// 返回的 n 是精确 int64（用于绑定），而 route.ts 回显的是 parseInt 的 double 结果；
// ≥ 2^53 的两者最多差 1024，回显侧的舍入在 listHandler 里折成 float64 复现。
func parseOffset(raw string) (n int64, ok, overflow bool) {
	if raw == "" {
		return 0, true, false
	}
	n, ok, overflow = jsparse.ParseIntWithOverflow(raw)
	if !ok {
		return 0, false, false
	}
	if n < 0 {
		return 0, true, false
	}
	return n, true, overflow
}
