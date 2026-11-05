package db

import (
	"context"
)

// CollectSourceAliasHit 是别名搜索的最小投影。
//
// 不返回 config：它是 JSON 列，存量库里是 SQLite TEXT，而 *json.RawMessage 只能
// 从 BLOB 扫描；JSON 列的读取表示留到 B1 域迁移时决定，这里只证明 json_each 查询
// 可以手写跑通。
type CollectSourceAliasHit struct {
	ID           int64
	Name         string
	ProjectScope string
}

// ListCollectSourcesByNameOrAlias 在 collect_sources.config 的 aliases 数组里做 LIKE 搜索。
//
// 为什么手写原生 SQL 而不是放进 queries/：json_each 是表值函数，sqlc 的 SQLite
// 解析器不支持（报 table alias "json_each" does not exist，研究文档 §2.11），
// 这类查询保留在仓储层手写。语义照抄 src/app/api/collect/sources/route.ts 的别名搜索。
func (q *Queries) ListCollectSourcesByNameOrAlias(ctx context.Context, likePattern string) ([]CollectSourceAliasHit, error) {
	const query = `
SELECT collect_sources.id, collect_sources.name, collect_sources.project_scope
FROM collect_sources
WHERE EXISTS (
  SELECT 1 FROM json_each(collect_sources.config, '$.aliases') WHERE json_each.value LIKE ?
)
ORDER BY collect_sources.id`

	rows, err := q.db.QueryContext(ctx, query, likePattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hits []CollectSourceAliasHit
	for rows.Next() {
		var h CollectSourceAliasHit
		if err := rows.Scan(&h.ID, &h.Name, &h.ProjectScope); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}
