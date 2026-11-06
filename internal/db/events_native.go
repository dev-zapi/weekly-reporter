package db

import (
	"context"
	"encoding/json"
)

// EventsByTagsParams 是 GET /api/events 的「全量标签筛选」分支参数。
//
// 为什么这条查询手写原生 SQL：tag 列表长度随请求变化（逗号分隔 0–N 个），
// sqlc 的 sqlc.slice 会展开成匿名占位符，与本查询里其余编号占位符冲突；
// 用 json_each 把列表作为 JSON 数组传入即可保持 SQL 文本静态。表值函数不被
// sqlc 解析器支持（ADR-0025），所以这类查询留在仓储层手写。
type EventsByTagsParams struct {
	Tags           []string
	SourceEqFilter int64
	SourceEq       string
	SourceNeFilter int64
	SourceNe       string
	CursorFilter   int64
	CursorTimeLt   int64
	CursorTimeEq   int64
	CursorIDFilter int64
	CursorID       int64
	Limit          int64
}

// ListEventsByTags 复刻 route.ts 的 tag 分支：
//
//	EXISTS (SELECT 1 FROM event_tags WHERE event_id = raw_events.id
//	        AND tag_name IN (filterTags))
//
// 有 tag 过滤时日期/周条件被 route.ts 主动跳过（全量语义），这里也不带它们；
// source 与游标条件照旧生效。排序与 limit 语义与 ListEvents 一致。
func (q *Queries) ListEventsByTags(ctx context.Context, params EventsByTagsParams) ([]ListEventsRow, error) {
	const query = `
SELECT id, event_time, source, content, CAST(metadata AS BLOB) AS metadata, category, created_at, updated_at, is_important,
       (SELECT COUNT(*) FROM comment_references WHERE comment_references.referenced_event_id = raw_events.id) AS comment_referrer_count
FROM raw_events
WHERE EXISTS (
    SELECT 1 FROM event_tags
    WHERE event_tags.event_id = raw_events.id
      AND event_tags.tag_name IN (SELECT value FROM json_each(?)))
  AND (? = 0 OR raw_events.source = ?)
  AND (? = 0 OR raw_events.source <> ?)
  AND (? = 0
       OR (? = 1
           AND (raw_events.event_time < ?
                OR (raw_events.event_time = ?
                    AND ? = 1
                    AND raw_events.id < ?))))
ORDER BY raw_events.event_time DESC
LIMIT ?`

	tagsJSON, err := json.Marshal(params.Tags)
	if err != nil {
		return nil, err
	}

	rows, err := q.db.QueryContext(ctx, query,
		string(tagsJSON),
		params.SourceEqFilter,
		params.SourceEq,
		params.SourceNeFilter,
		params.SourceNe,
		params.CursorFilter,
		params.CursorFilter,
		params.CursorTimeLt,
		params.CursorTimeEq,
		params.CursorIDFilter,
		params.CursorID,
		params.Limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []ListEventsRow{}
	for rows.Next() {
		var i ListEventsRow
		if err := rows.Scan(
			&i.ID,
			&i.EventTime,
			&i.Source,
			&i.Content,
			&i.Metadata,
			&i.Category,
			&i.CreatedAt,
			&i.UpdatedAt,
			&i.IsImportant,
			&i.CommentReferrerCount,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
