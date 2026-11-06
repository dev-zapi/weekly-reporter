package db

import (
	"context"
	"fmt"
	"strings"
)

// 本文件是 B4 采集源数据面里 sqlc 无法表达的手写 SQL（ADR-0025）：
//
//   - 分页列表的条件与排序都是动态的，且 name 过滤要用 json_each 表值函数
//     （sqlc 的 SQLite 解析器不支持，见 queries/common.sql 的 B0 发现）；
//   - COUNT 必须复用同一组条件；
//   - 两个 bulk 操作的 IN 列表长度随请求变化。
//
// 语义唯一事实源是 src/app/api/collect/sources/**/route.ts 里的 drizzle 查询。

// CollectSourceRecord 是 collect_sources 一行的原始值。
//
// Config 是 SQLite TEXT 里的 JSON 文本，与 sqlc row 的 []byte 同形（读路径统一
// CAST(config AS BLOB)）。时间列是 Unix 秒（drizzle timestamp mode）。
type CollectSourceRecord struct {
	ID             int64
	Type           string
	Name           string
	Config         []byte
	Enabled        int64
	Status         *string
	ProjectScope   string
	LastSyncAt     *int64
	LastSyncStatus *string
	CreatedAt      int64
	UpdatedAt      int64
}

// 三个 sqlc 读查询投影的列完全相同，收成一个记录类型，避免 API 层为每种行写一份
// 字段搬运。行类型全部由 queries/collect_sources.sql 生成。

func (r GetCollectSourceRow) Record() CollectSourceRecord {
	return CollectSourceRecord(r)
}

func (r ListCollectSourcesRow) Record() CollectSourceRecord {
	return CollectSourceRecord(r)
}

func (r ListCollectSourcesByTypeRow) Record() CollectSourceRecord {
	return CollectSourceRecord(r)
}

// CollectSourcesFilter 是 GET /api/collect/sources 的过滤条件。
//
// 各 *Set 字段对应 route.ts 里 `if (type)` 这类真值判断：只有非空值才落进 WHERE。
// SyncStatus 已按 route.ts 归一成 success / failed / never 三种（failure 与 failed
// 是同义拼写，对应 last_sync_status IN ('failed','failure')）。
type CollectSourcesFilter struct {
	Type            string
	TypeSet         bool
	Name            string
	NameSet         bool
	SyncStatus      string
	SourceStatus    string
	SourceStatusSet bool
	ProjectScope    string
	ScopeSet        bool
}

// CollectSourcesOrder 是排序白名单结果（route.ts 的 SORTABLE_COLUMNS + 默认列）。
type CollectSourcesOrder struct {
	Column string // name/type/project_scope/last_sync_at/status，空 = last_sync_at
	Asc    bool
}

// CollectSourcesPage 是分页窗口。HasLimit/HasOffset 对应 drizzle 只在真值/非负时
// 才拼子句的行为：NaN / 负数 limit 整条 LIMIT 消失，NaN / 0 offset 整条 OFFSET 消失。
type CollectSourcesPage struct {
	Limit     int64
	HasLimit  bool
	Offset    int64
	HasOffset bool
}

var collectSourcesOrderColumns = map[string]string{
	"name":          "collect_sources.name",
	"type":          "collect_sources.type",
	"project_scope": "collect_sources.project_scope",
	"last_sync_at":  "collect_sources.last_sync_at",
	"status":        "collect_sources.status",
}

// collectSourcesWhere 把过滤器折成 SQL 片段与参数。谓词形状逐条对照 route.ts：
//   - name：name LIKE %n% OR EXISTS(json_each(config, '$.aliases') LIKE %n%)；
//   - failed：last_sync_status IN ('failed','failure')（SYNC_FAILED_STATUSES）；
//   - never：last_sync_at IS NULL。
func collectSourcesWhere(filter CollectSourcesFilter) (string, []any) {
	var clauses []string
	var args []any

	if filter.TypeSet {
		clauses = append(clauses, "collect_sources.type = ?")
		args = append(args, filter.Type)
	}
	if filter.NameSet {
		pattern := "%" + filter.Name + "%"
		clauses = append(clauses, `(collect_sources.name LIKE ? OR EXISTS (SELECT 1 FROM json_each(collect_sources.config, '$.aliases') WHERE json_each.value LIKE ?))`)
		args = append(args, pattern, pattern)
	}
	switch filter.SyncStatus {
	case "success":
		clauses = append(clauses, "collect_sources.last_sync_status = 'success'")
	case "failed":
		clauses = append(clauses, "collect_sources.last_sync_status IN ('failed','failure')")
	case "never":
		clauses = append(clauses, "collect_sources.last_sync_at IS NULL")
	}
	if filter.SourceStatusSet {
		clauses = append(clauses, "collect_sources.status = ?")
		args = append(args, filter.SourceStatus)
	}
	if filter.ScopeSet {
		clauses = append(clauses, "collect_sources.project_scope = ?")
		args = append(args, filter.ProjectScope)
	}

	if len(clauses) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func collectSourcesOrderSQL(order CollectSourcesOrder) string {
	column, ok := collectSourcesOrderColumns[order.Column]
	if !ok {
		column = collectSourcesOrderColumns["last_sync_at"]
	}
	direction := "DESC"
	if order.Asc {
		direction = "ASC"
	}
	return " ORDER BY " + column + " " + direction
}

// ListCollectSourcesPage 复刻 drizzle relational findMany({where, orderBy, limit, offset})。
func (q *Queries) ListCollectSourcesPage(ctx context.Context, filter CollectSourcesFilter, order CollectSourcesOrder, page CollectSourcesPage) ([]CollectSourceRecord, error) {
	where, args := collectSourcesWhere(filter)
	sql := "SELECT " + collectSourceReadColumns + " FROM collect_sources" + where + collectSourcesOrderSQL(order)
	if page.HasLimit {
		sql += " LIMIT ?"
		args = append(args, page.Limit)
	}
	if page.HasOffset {
		// OFFSET 只有在 LIMIT 之后才合法。route.ts 在 limit 缺失（NaN/负数）却
		// offset 非零时会拼出非法 SQL → catch → 500 FETCH_ERROR；这里返回错误，
		// 由 API 层映射成同一条 500。
		if !page.HasLimit {
			return nil, fmt.Errorf("collect sources: OFFSET without LIMIT")
		}
		sql += " OFFSET ?"
		args = append(args, page.Offset)
	}

	rows, err := q.db.QueryContext(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCollectSourceRecords(rows)
}

// CountCollectSources 复刻 `select count(*) from collect_sources where <same>`。
func (q *Queries) CountCollectSources(ctx context.Context, filter CollectSourcesFilter) (int64, error) {
	where, args := collectSourcesWhere(filter)
	var total int64
	if err := q.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM collect_sources"+where, args...).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

// DeleteCollectSourcesByIDs 复刻 `delete().where(inArray(id, ids)).returning()`：
// 用 json_each 把 id 列表作为 JSON 数组传入，返回实际删除的行数（= returning().length）。
func (q *Queries) DeleteCollectSourcesByIDs(ctx context.Context, idsJSON string) (int64, error) {
	rows, err := q.db.QueryContext(ctx, "DELETE FROM collect_sources WHERE id IN (SELECT value FROM json_each(?)) RETURNING id", idsJSON)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var count int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		count++
	}
	return count, rows.Err()
}

// UpdateCollectSourcesProjectScope 复刻 bulk-update-scope 的
// `update().set({projectScope, updatedAt}).where(inArray(id, ids)).returning()`。
func (q *Queries) UpdateCollectSourcesProjectScope(ctx context.Context, idsJSON string, projectScope string, updatedAt int64) (int64, error) {
	rows, err := q.db.QueryContext(ctx,
		"UPDATE collect_sources SET project_scope = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) RETURNING id",
		projectScope, updatedAt, idsJSON)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var count int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		count++
	}
	return count, rows.Err()
}

// CollectSourceWrite 是 create/update/patch 三个写路径的共同输入。
//
// Config 是 JSON 文本（非 []byte）：database/sql 把 string 绑成 TEXT，与 drizzle
// 的 json mode 写出的表示一致；[]byte 会绑成 BLOB，Next 运行时还在读同一张表。
// Enabled 为 nil 表示「这次不改 enabled」（PUT 的 body 没带 / PATCH 没带）。
type CollectSourceWrite struct {
	Type         string
	Name         string
	Config       string
	Enabled      *int64
	Status       *string
	ProjectScope string
	UpdatedAt    int64
}

const collectSourceReadColumns = `id, type, name, CAST(config AS BLOB) AS config, enabled, status, project_scope, last_sync_at, last_sync_status, created_at, updated_at`

// InsertCollectSource 复刻 POST 的 `insert().values({...}).returning()`：
// id 走 AUTOINCREMENT，last_sync_at / last_sync_status 留 NULL。
func (q *Queries) InsertCollectSource(ctx context.Context, w CollectSourceWrite, createdAt int64) (CollectSourceRecord, error) {
	row := q.db.QueryRowContext(ctx,
		`INSERT INTO collect_sources (type, name, config, enabled, status, project_scope, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
RETURNING `+collectSourceReadColumns,
		w.Type, w.Name, w.Config, enabledValue(w.Enabled, 1), w.Status, w.ProjectScope, createdAt, w.UpdatedAt,
	)
	return scanCollectSourceRecord(row)
}

// UpdateCollectSource 复刻 PUT 的 `update().set({...validated, config, status, updatedAt})`：
// type/name/config/status/project_scope/updated_at 总是重写，enabled 只在 body
// 带了该键时才重写（drizzle 的 mapUpdateSet 丢掉 undefined）。
func (q *Queries) UpdateCollectSource(ctx context.Context, id int64, w CollectSourceWrite) (CollectSourceRecord, error) {
	row := q.db.QueryRowContext(ctx,
		`UPDATE collect_sources
SET type = ?, name = ?, config = ?, enabled = COALESCE(?, enabled),
    status = ?, project_scope = ?, updated_at = ?
WHERE id = ?
RETURNING `+collectSourceReadColumns,
		w.Type, w.Name, w.Config, w.Enabled, w.Status, w.ProjectScope, w.UpdatedAt, id,
	)
	return scanCollectSourceRecord(row)
}

// PatchCollectSource 复刻 PATCH 的动态 set：只有 body 里出现的列会被重写。
func (q *Queries) PatchCollectSource(ctx context.Context, id int64, enabled *int64, status *string, config *string, updatedAt int64) (CollectSourceRecord, error) {
	row := q.db.QueryRowContext(ctx,
		`UPDATE collect_sources
SET enabled = COALESCE(?, enabled),
    status = COALESCE(?, status),
    config = COALESCE(?, config),
    updated_at = ?
WHERE id = ?
RETURNING `+collectSourceReadColumns,
		enabled, status, config, updatedAt, id,
	)
	return scanCollectSourceRecord(row)
}

// enabledValue 复刻 drizzle boolean mode 的 mapToDriverValue：true → 1，false → 0。
func enabledValue(v *int64, fallback int64) int64 {
	if v == nil {
		return fallback
	}
	return *v
}

func scanCollectSourceRecord(row interface{ Scan(dest ...any) error }) (CollectSourceRecord, error) {
	var r CollectSourceRecord
	err := row.Scan(&r.ID, &r.Type, &r.Name, &r.Config, &r.Enabled, &r.Status, &r.ProjectScope, &r.LastSyncAt, &r.LastSyncStatus, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

// scanCollectSourceRecords 复刻 drizzle 的列映射：config 是 JSON 文本，enabled 是
// boolean mode（存 0/1），时间列是 Unix 秒。
func scanCollectSourceRecords(rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}) ([]CollectSourceRecord, error) {
	records := []CollectSourceRecord{}
	for rows.Next() {
		var r CollectSourceRecord
		if err := rows.Scan(&r.ID, &r.Type, &r.Name, &r.Config, &r.Enabled, &r.Status, &r.ProjectScope, &r.LastSyncAt, &r.LastSyncStatus, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	return records, rows.Err()
}
