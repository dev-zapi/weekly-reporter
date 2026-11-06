package plans

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/lib/plan-item-comments/{db,authors}.ts 的 server-only 部分。

// sourcePeriod 是评论来源周期的标签形状（CommentSourcePeriod）。
type sourcePeriod struct {
	Scope       string  `json:"scope"`
	PeriodStart string  `json:"periodStart"`
	PeriodEnd   string  `json:"periodEnd"`
	MonthKey    *string `json:"monthKey"`
	Label       string  `json:"label"`
}

// chainComment 是 listChainComments 的元素：评论自身字段 + 来源周期。
type chainComment struct {
	ID           int64        `json:"id"`
	PlanItemID   int64        `json:"planItemId"`
	Content      string       `json:"content"`
	Author       *string      `json:"author"`
	CreatedAt    string       `json:"createdAt"`
	SourcePeriod sourcePeriod `json:"sourcePeriod"`
}

// buildSourcePeriod 复刻 buildSourcePeriod：week 用起止日，month 用 monthKey
// （缺失时退化为 periodStart 的前 7 位）。
func buildSourcePeriod(scope, periodStart, periodEnd string, monthKey *string) sourcePeriod {
	label := "Month " + monthOrStart(monthKey, periodStart)
	if scope == "week" {
		label = "Week " + periodStart + " - " + periodEnd
	}
	return sourcePeriod{
		Scope:       scope,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
		MonthKey:    monthKey,
		Label:       label,
	}
}

func monthOrStart(monthKey *string, periodStart string) string {
	if monthKey != nil {
		return *monthKey
	}
	if len(periodStart) >= 7 {
		return periodStart[:7]
	}
	return periodStart
}

// listChainComments 复刻 listChainComments：条目自身的评论加全部顺延祖先的评论，
// 全局最早在前（createdAt, id）。评论留在写入时的条目上，这里只是读侧聚合。
func listChainComments(ctx context.Context, q *db.Queries, itemID int64) ([]chainComment, error) {
	chain, err := fulfillmentChain(ctx, q, itemID)
	if err != nil {
		return nil, err
	}
	if len(chain) == 0 {
		return []chainComment{}, nil
	}

	rows, err := q.ListPlanItemCommentsByItemIDs(ctx, chain)
	if err != nil {
		return nil, err
	}

	comments := make([]chainComment, 0, len(rows))
	for _, row := range rows {
		comments = append(comments, chainComment{
			ID:           row.ID,
			PlanItemID:   row.PlanItemID,
			Content:      row.Content,
			Author:       row.Author,
			CreatedAt:    isoMillis(row.CreatedAt),
			SourcePeriod: buildSourcePeriod(row.Scope, row.PeriodStart, row.PeriodEnd, row.MonthKey),
		})
	}
	return comments, nil
}

// chainCommentCount 复刻 getChainCommentCount：与 listChainComments 的长度保持
// 相等（同一个链），徽标才不会与展开区不一致。
func chainCommentCount(ctx context.Context, q *db.Queries, itemID int64) (int, error) {
	chain, err := fulfillmentChain(ctx, q, itemID)
	if err != nil {
		return 0, err
	}
	if len(chain) == 0 {
		return 0, nil
	}
	count, err := q.CountPlanItemCommentsByItemIDs(ctx, chain)
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// createComment 复刻 createComment：同一个事务里写入评论并索引 `@<eventId>`
// 引用。评论不可变，所以这是唯一的解析时机；`%<itemId>` 与 `#tag` 在评论里
// 永远只是纯文本（ADR-0024）。
func createComment(ctx context.Context, q *db.Queries, planItemID int64, content string, author *string) (db.PlanItemComment, error) {
	var comment db.PlanItemComment
	err := q.InTx(ctx, func(tx *db.Queries) error {
		inserted, err := tx.InsertPlanItemComment(ctx, db.InsertPlanItemCommentParams{
			PlanItemID: planItemID,
			Content:    content,
			Author:     author,
			CreatedAt:  nowUnix(),
		})
		if err != nil {
			return err
		}
		comment = inserted

		referencedIDs := parseEventReferences(content)
		if len(referencedIDs) == 0 {
			return nil
		}
		now := nowUnix()
		for _, eventID := range referencedIDs {
			if err := tx.InsertCommentReference(ctx, db.InsertCommentReferenceParams{
				CommentID:         comment.ID,
				ReferencedEventID: eventID,
				CreatedAt:         now,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return db.PlanItemComment{}, err
	}
	return comment, nil
}

// findComment 复刻 findComment。
func findComment(ctx context.Context, q *db.Queries, commentID int64) (db.PlanItemComment, bool, error) {
	row, err := q.GetPlanItemComment(ctx, commentID)
	if errors.Is(err, sql.ErrNoRows) {
		return db.PlanItemComment{}, false, nil
	}
	if err != nil {
		return db.PlanItemComment{}, false, err
	}
	return row, true, nil
}

// deleteComment 复刻 deleteComment：删评论及其引用索引行（唯一变更路径）。
func deleteComment(ctx context.Context, q *db.Queries, commentID int64) error {
	return q.InTx(ctx, func(tx *db.Queries) error {
		if err := tx.DeleteCommentReferencesByCommentID(ctx, commentID); err != nil {
			return err
		}
		_, err := tx.DeletePlanItemComment(ctx, commentID)
		return err
	})
}

// deleteCommentsByPlanItem 复刻 deleteCommentsByPlanItem：在调用方事务里
// 级联删掉条目的评论与它们的引用行。
func deleteCommentsByPlanItem(ctx context.Context, tx *db.Queries, planItemID int64) error {
	if err := tx.DeleteCommentReferencesByPlanItemID(ctx, planItemID); err != nil {
		return err
	}
	return tx.DeletePlanItemCommentsByPlanItemID(ctx, planItemID)
}

// deriveCommentAuthor 复刻 authors.ts 的 deriveCommentAuthor：
// 浏览器调用（密码/关闭模式）存 null；PAT 调用存自报 agent 身份，缺失时退回
// PAT 名，再退回字面量 `pat`。只是归因，不是安全边界。
func deriveCommentAuthor(ctx context.Context, r *requestHeaders) *string {
	result, ok := auth.ResultFromContext(ctx)
	if !ok || result.Mode != auth.ModePAT {
		return nil
	}
	if identity := r.headerValue("X-Weekly-Reporter-Agent"); identity != nil {
		return identity
	}
	if result.PATName != nil {
		return result.PATName
	}
	pat := "pat"
	return &pat
}

// requestHeaders 只暴露请求头读取，隔离 deriveCommentAuthor 对 *http.Request 的依赖。
type requestHeaders struct {
	values func(name string) []string
}

// headerValue 复刻 `request.headers.get(name)`：头缺失 → nil；存在但为空 →
// 指向空串；同名多值按 Headers 语义用 ", " 连接。
func (h *requestHeaders) headerValue(name string) *string {
	values := h.values(name)
	if values == nil {
		return nil
	}
	joined := strings.Join(values, ", ")
	return &joined
}

// parseEventReferences 复刻 src/lib/references/parse.ts 的 parseReferences：
// 提取 `@<id>`，按出现顺序去重，只保留 > 0 的有限整数。
//
// 与 events 域的 parseIDReferences 同一规则，但那一个未导出：评论解析是唯一
// 消费者，这里保留一份最小实现，避免让 plans 包反向依赖 events 域。
func parseEventReferences(content string) []int64 {
	runes := []rune(content)
	seen := make(map[int64]struct{})
	ids := []int64{}

	for i := 0; i < len(runes); i++ {
		if runes[i] != '@' {
			continue
		}
		if i > 0 && !jsstr.IsSpace(runes[i-1]) {
			continue
		}
		start := i + 1
		end := start
		for end < len(runes) && runes[end] >= '0' && runes[end] <= '9' {
			end++
		}
		if end == start {
			continue
		}
		if end < len(runes) && !jsstr.IsSpace(runes[end]) {
			continue
		}
		id := digitsToID(runes[start:end])
		if id <= 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

// digitsToID 把纯数字段折成 int64；溢出饱和到 MaxInt64（JS 那边是有限浮点数，
// 查库必然查不到，可观测结果一致）。
func digitsToID(digits []rune) int64 {
	var n int64
	for _, r := range digits {
		d := int64(r - '0')
		if n > (1<<63-1-d)/10 {
			return 1<<63 - 1
		}
		n = n*10 + d
	}
	return n
}
