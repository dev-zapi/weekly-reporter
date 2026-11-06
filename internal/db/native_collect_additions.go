package db

import (
	"context"
	"encoding/json"
)

// 本文件是 B4 两条增补路由（POST /api/collect/scan-repos、
// POST /api/collect/batch-add-sources）的手写原生 SQL。
//
// 为什么不进 queries/（ADR-0025）：B4 的三张票并行施工，#103（collect sources
// CRUD）是 queries/collect.sql 的归属票；本票只做一条只读投影与一条单行 INSERT，
// 放在仓储层手写与 B2 的 native_events.go 是同一先例。两条语句都是常规 SQL，
// 若后续 merge 后统一收口到 sqlc，语义不变。
//
// config 是 JSON 文本列（drizzle mode:'json'）。读路径照 ListCollectSourcesForAliases
// 做 CAST(config AS BLOB)，因为 *json.RawMessage / []byte 只能从 BLOB 扫描。

// ListGitLocalCollectSourceOwners 复刻 actions.ts 的
//
//	db.query.collectSources.findMany({where: eq(collectSources.type, 'git-local')})
//	  .map(s => s.config.owner)
//
// 即 knownPaths 集合。drizzle 的 json mode 在读取时做 JSON.parse：非法 JSON
// 让整条请求落进 catch（返回 {repos: [], error: message}），这里用同样的错误路径。
// 非对象 / 缺 owner / owner 非字符串一律视为 undefined：不进入集合。
func (q *Queries) ListGitLocalCollectSourceOwners(ctx context.Context) ([]string, error) {
	const query = `
SELECT CAST(config AS BLOB) AS config
FROM collect_sources
WHERE type = 'git-local'`

	rows, err := q.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var owners []string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var config any
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, err
		}
		object, ok := config.(map[string]any)
		if !ok {
			continue
		}
		if owner, ok := object["owner"].(string); ok {
			owners = append(owners, owner)
		}
	}
	return owners, rows.Err()
}

// InsertGitLocalCollectSourceParams 是 batchAddSources 单行插入的入参。
type InsertGitLocalCollectSourceParams struct {
	Name      string
	Config    string
	Enabled   int64
	CreatedAt int64
	UpdatedAt int64
}

// InsertGitLocalCollectSource 复刻 actions.ts 的
//
//	db.insert(collectSources).values({
//	  type: 'git-local', name, config: {owner, authorEmails, branches: []},
//	  enabled: true, createdAt: now, updatedAt: now,
//	})
//
// 列清单与 drizzle 一致：status / project_scope 不写，交给 schema 默认值
// （'enabled' / 'personal'）。时间戳是 Unix 秒（ADR-0025：drizzle
// {mode:'timestamp'} 写秒）。
func (q *Queries) InsertGitLocalCollectSource(ctx context.Context, params InsertGitLocalCollectSourceParams) error {
	const query = `
INSERT INTO collect_sources (type, name, config, enabled, created_at, updated_at)
VALUES ('git-local', ?, ?, ?, ?, ?)`

	_, err := q.db.ExecContext(ctx, query, params.Name, params.Config, params.Enabled, params.CreatedAt, params.UpdatedAt)
	return err
}
