package db

import (
	"context"
)

// 本文件是 B2 只读重查询（heatmap 聚合）的手写原生 SQL。
//
// 为什么不进 queries/（ADR-0025）：B2 的两张票并行施工，queries/ 目录归基础
// CRUD 票（它要在同一目录加 sqlc 查询并跑 make sqlc），本票只做只读反查/聚合。
// ADR-0025 的配方本来就把这类由表值函数或复杂连接驱动的查询留在仓储层手写，
// B0 的 native.go 是同一形状的先例。这里只做投影与连接，聚合与日期归键留在
// API 域包，逐条对照 src/app/api/events/**/route.ts。

// heatmapEventTimes 复刻 route.ts 的
//
//	db.select({ eventTime }).from(rawEvents).where(gte(rawEvents.eventTime, cutoff))
//	  .orderBy(desc(rawEvents.eventTime))
//
// 只取 event_time：聚合键是本地日期，放在 Go 侧用服务进程的时区算，与 JS 的
// getFullYear/getMonth/getDate 同源。排序照抄 desc：虽然 Map 之后会重排，
// 但先按 route.ts 的形状把行序定下来，聚合结果与之无关。
const heatmapEventTimes = `
SELECT event_time
FROM raw_events
WHERE event_time >= ?
ORDER BY event_time DESC`

// ListHeatmapEventTimes 返回 event_time >= cutoff（Unix 秒）的事件时刻，倒序。
// cutoff 由调用方按 route.ts 的 setDate(now - days) 语义算好后传入。
func (q *Queries) ListHeatmapEventTimes(ctx context.Context, cutoff int64) ([]int64, error) {
	rows, err := q.db.QueryContext(ctx, heatmapEventTimes, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var times []int64
	for rows.Next() {
		var t int64
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		times = append(times, t)
	}
	return times, rows.Err()
}
