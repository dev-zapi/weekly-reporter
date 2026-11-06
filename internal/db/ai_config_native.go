package db

import "context"

// 本文件是 settings/ai 配置面里 sqlc 无法表达的手写 SQL（ADR-0025）：
//
// model_list_cache 是 drizzle mode:'json' 列，库里是 JSON *text*。sqlc 会把该列
// 的参数类型推成 json.RawMessage（[]byte），database/sql 会绑成 BLOB；Next 运行时
// 在 cutover 前还读同一个库，所以写路径必须和 drizzle 一样写 TEXT。读路径仍走
// sqlc（CAST(model_list_cache AS BLOB)），见 queries/ai_config.sql。
//
// 方法名带 ForSettings 后缀：B5 的 ai/* 票（#106）会在同一张表上新增读写，避免
// 两个 worktree 合并时出现重复方法名。

const updateAIConfigModelListForSettings = `
UPDATE ai_config
SET model_list_cache = ?, model_list_cached_at = ?, updated_at = ?
WHERE id = ?`

// UpdateAIConfigModelListForSettings 复刻 updateModelListCache 的
// `update().set({modelListCache, modelListCachedAt, updatedAt})`。
//
// modelsJSON 为 nil 时写 SQL NULL（对应 models 为 null 的分支）；cachedAt 同理。
// 这里分两条语句而不是用 COALESCE，是为了区分「显式写 NULL」与「写空串」——
// 空的模型列表是 []（truthy），缓存时间和缓存值都会写。
func (q *Queries) UpdateAIConfigModelListForSettings(ctx context.Context, id int64, modelsJSON *string, cachedAt *int64, updatedAt int64) error {
	if modelsJSON == nil {
		_, err := q.db.ExecContext(ctx,
			`UPDATE ai_config SET model_list_cache = NULL, model_list_cached_at = NULL, updated_at = ? WHERE id = ?`,
			updatedAt, id)
		return err
	}
	_, err := q.db.ExecContext(ctx, updateAIConfigModelListForSettings,
		*modelsJSON, cachedAt, updatedAt, id)
	return err
}
