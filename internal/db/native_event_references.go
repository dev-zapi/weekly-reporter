package db

import (
	"context"
	"database/sql"
	"errors"
)

// 本文件是 B2 事件引用反查（`GET /api/events/{id}/references`）的手写原生 SQL。
//
// 为什么不进 queries/（ADR-0025）：queries/ 目录归 B2 另一张票（基础 CRUD 票），
// 它要在同一目录加 sqlc 查询并跑 make sqlc：本票的查询与那张票无耦合，放进
// queries/ 只会制造并行施工的冲突面。ADR-0025 允许这类查询留在仓储层手写，
// B0 的 native.go 是同一形状的先例。投影与连接在这里，excerpt 折叠与 ISO 串
// 留在 API 域包，逐条对照 route.ts 与 src/lib/**/db.ts。

// rawEventExists 复刻 route.ts 的存在性检查（select id ... limit 1 .get()）。
const rawEventExists = `SELECT 1 FROM raw_events WHERE id = ? LIMIT 1`

// RawEventExists 报告事件是否存在。
func (q *Queries) RawEventExists(ctx context.Context, id int64) (bool, error) {
	var one int64
	err := q.db.QueryRowContext(ctx, rawEventExists, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// EventReferrerRow 是 findReferrers 的行投影：引用方事件的最小字段。
type EventReferrerRow struct {
	ID        int64
	Content   string
	EventTime int64
}

// eventReferrers 复刻 src/lib/references/db.ts 的 findReferrers：内连接
// raw_events，按 referenced_event_id 反查。route.ts 没有 orderBy，这里也刻意
// 不排序——行序属于 SQLite 的自由度，不是契约的一部分。
const eventReferrers = `
SELECT raw_events.id, raw_events.content, raw_events.event_time
FROM event_references
INNER JOIN raw_events ON event_references.event_id = raw_events.id
WHERE event_references.referenced_event_id = ?`

// ListEventReferrers 返回引用了 referencedEventID 的事件行。
// 悬挂引用（引用方事件已被删除）被内连接自然丢弃（ADR-0016）。
func (q *Queries) ListEventReferrers(ctx context.Context, referencedEventID int64) ([]EventReferrerRow, error) {
	rows, err := q.db.QueryContext(ctx, eventReferrers, referencedEventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []EventReferrerRow
	for rows.Next() {
		var r EventReferrerRow
		if err := rows.Scan(&r.ID, &r.Content, &r.EventTime); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CommentReferrerRow 是 findCommentReferrers 的行投影（content 由 API 域转成
// excerpt，所以这里保留原文）。
type CommentReferrerRow struct {
	CommentID   int64
	Content     string
	Author      *string
	CreatedAt   int64
	PlanItemID  int64
	Scope       string
	PeriodStart string
	PeriodEnd   string
	MonthKey    *string
}

// commentReferrers 复刻 src/lib/plan-item-comments/db.ts 的 findCommentReferrers，
// 含其显式排序 asc(createdAt), asc(id)。
const commentReferrers = `
SELECT
  plan_item_comments.id,
  plan_item_comments.content,
  plan_item_comments.author,
  plan_item_comments.created_at,
  plan_item_comments.plan_item_id,
  period_plans.scope,
  period_plans.period_start,
  period_plans.period_end,
  period_plans.month_key
FROM comment_references
INNER JOIN plan_item_comments ON comment_references.comment_id = plan_item_comments.id
INNER JOIN period_plan_items ON plan_item_comments.plan_item_id = period_plan_items.id
INNER JOIN period_plans ON period_plan_items.period_plan_id = period_plans.id
WHERE comment_references.referenced_event_id = ?
ORDER BY plan_item_comments.created_at ASC, plan_item_comments.id ASC`

// ListCommentReferrers 返回引用了 referencedEventID 的计划条目评论。
func (q *Queries) ListCommentReferrers(ctx context.Context, referencedEventID int64) ([]CommentReferrerRow, error) {
	rows, err := q.db.QueryContext(ctx, commentReferrers, referencedEventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CommentReferrerRow
	for rows.Next() {
		var r CommentReferrerRow
		if err := rows.Scan(
			&r.CommentID,
			&r.Content,
			&r.Author,
			&r.CreatedAt,
			&r.PlanItemID,
			&r.Scope,
			&r.PeriodStart,
			&r.PeriodEnd,
			&r.MonthKey,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
