package plans

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/lib/plan-items.ts：优先级/象限标志校验、周期计划自动创建、
// week→month 父链接校验，以及 src/lib/plan-references/fulfillment.ts 的
// 顺延链与达成聚合、src/lib/plan-item-comments/db.ts 的链式评论读取。

// planItemStatuses 逐值对应 PERIOD_PLAN_ITEM_STATUSES（schema 常量）。
var planItemStatuses = []string{"planned", "in_progress", "done", "cancelled", "deferred"}

// planItemPriorities 逐值对应 PERIOD_PLAN_ITEM_PRIORITIES。
var planItemPriorities = []string{"high", "normal", "low"}

// priorityOrder 是 PLAN_ITEM_PRIORITY_ORDER（plan-item-display.ts 的键序），
// 即 sort/attachCandidates 用的优先级名次表。
var priorityOrder = planItemPriorities

func indexOf(values []string, target string) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return -1
}

// errInvalidPriority 等是 validatePlanItemPriorityFields 的错误形状：
// {error, code}，与 route.ts 的 400 响应体一致。
type fieldError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

// jsonField 复刻「属性存在性 + 值」这一对：route.ts 用 `x !== undefined` 区分
// 「没传」与「传了 null」，两者在后来的校验里结果不同（null 会落到类型校验）。
type jsonField struct {
	Present bool
	Value   any
}

// fieldOf 取 body 里的一个字段。
func fieldOf(body map[string]any, key string) jsonField {
	value, present := body[key]
	return jsonField{Present: present, Value: value}
}

// validatePlanItemPriorityFields 复刻 src/lib/plan-items.ts 的同名函数。
// 只有「没传」被接受；各调用方自行决定缺省值（POST）或保留旧值（PUT）。
func validatePlanItemPriorityFields(priority, isImportant, isUrgent jsonField) *fieldError {
	if priority.Present {
		value, ok := priority.Value.(string)
		if !ok || indexOf(planItemPriorities, value) < 0 {
			return &fieldError{
				Error: "Invalid priority. Must be one of: " + joinComma(planItemPriorities),
				Code:  "INVALID_PRIORITY",
			}
		}
	}
	if isImportant.Present {
		if _, ok := isImportant.Value.(bool); !ok {
			return &fieldError{Error: "isImportant must be a boolean", Code: "INVALID_IS_IMPORTANT"}
		}
	}
	if isUrgent.Present {
		if _, ok := isUrgent.Value.(bool); !ok {
			return &fieldError{Error: "isUrgent must be a boolean", Code: "INVALID_IS_URGENT"}
		}
	}
	return nil
}

func joinComma(values []string) string {
	out := ""
	for i, value := range values {
		if i > 0 {
			out += ", "
		}
		out += value
	}
	return out
}

// ensurePeriodPlan 复刻 src/lib/plan-items.ts 的 ensurePeriodPlan：按
// (scope, periodStart, periodEnd) 找，找不到就建。「首次写条目自动建计划」是
// 计划实体可以没有显式「创建计划」步骤的全部原因。
func ensurePeriodPlan(ctx context.Context, q *db.Queries, scope, periodStart, periodEnd string, monthKey *string) (db.PeriodPlan, error) {
	existing, err := q.GetPeriodPlanByPeriod(ctx, db.GetPeriodPlanByPeriodParams{
		Scope:       scope,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
	})
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return db.PeriodPlan{}, err
	}

	now := time.Now().Unix()
	return q.InsertPeriodPlan(ctx, db.InsertPeriodPlanParams{
		Scope:       scope,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
		MonthKey:    monthKey,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
}

// parentLinkValidation 复刻 ParentLinkValidation：ok 或 {error}。
type parentLinkValidation struct {
	OK    bool
	Error string
}

// validateParentLink 复刻 src/lib/plan-items.ts 的 validateParentLink：
// 结构是单向的（week 条目可以挂到 month 条目上，反之不行），且父条目所在
// 日历月必须包含子周的开始日，父链因此永不跨期。
func validateParentLink(ctx context.Context, q *db.Queries, childScope, childPeriodStart string, parentItemID int64) (parentLinkValidation, error) {
	if childScope != "week" {
		return parentLinkValidation{Error: "parentItemId is only allowed on week items"}, nil
	}

	parentItem, err := q.GetPlanItem(ctx, parentItemID)
	if errors.Is(err, sql.ErrNoRows) {
		return parentLinkValidation{Error: "parentItemId does not reference an existing item"}, nil
	}
	if err != nil {
		return parentLinkValidation{}, err
	}

	parentPlan, err := q.GetPeriodPlan(ctx, parentItem.PeriodPlanID)
	if errors.Is(err, sql.ErrNoRows) {
		return parentLinkValidation{Error: "parentItemId must reference a month item"}, nil
	}
	if err != nil {
		return parentLinkValidation{}, err
	}
	if parentPlan.Scope != "month" {
		return parentLinkValidation{Error: "parentItemId must reference a month item"}, nil
	}

	// 字符串比较即可：三个值都是 yyyy-MM-dd。
	if childPeriodStart < parentPlan.PeriodStart || childPeriodStart > parentPlan.PeriodEnd {
		return parentLinkValidation{Error: "parentItemId must belong to the month containing the week start date"}, nil
	}

	return parentLinkValidation{OK: true}, nil
}

// fulfillmentChain 复刻 getFulfillmentChain：沿 deferredFromItemId 向上走，
// 返回 [itemID, ...祖先]；遇到已访问的 id 就停（防环）。
func fulfillmentChain(ctx context.Context, q *db.Queries, itemID int64) ([]int64, error) {
	chain := []int64{}
	visited := map[int64]struct{}{}
	current := &itemID

	for current != nil {
		if _, dup := visited[*current]; dup {
			break
		}
		visited[*current] = struct{}{}

		link, err := q.GetPlanItemDeferralLink(ctx, *current)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			return nil, err
		}

		chain = append(chain, link.ID)
		current = link.DeferredFromItemID
	}
	return chain, nil
}

// fulfillmentEventIDs 复刻 getFulfillmentEventIds：给一组条目 id 返回它们
// 引用到的去重事件 id 集合（不自己走链）。
func fulfillmentEventIDs(ctx context.Context, q *db.Queries, itemIDs []int64) (map[int64]struct{}, error) {
	if len(itemIDs) == 0 {
		return map[int64]struct{}{}, nil
	}
	rows, err := q.ListFulfillmentEventIDs(ctx, itemIDs)
	if err != nil {
		return nil, err
	}
	ids := make(map[int64]struct{}, len(rows))
	for _, id := range rows {
		ids[id] = struct{}{}
	}
	return ids, nil
}

// fulfillmentCount 复刻 getFulfillmentCount：链上去重后的达成事件数。
func fulfillmentCount(ctx context.Context, q *db.Queries, itemID int64) (int, error) {
	chain, err := fulfillmentChain(ctx, q, itemID)
	if err != nil {
		return 0, err
	}
	ids, err := fulfillmentEventIDs(ctx, q, chain)
	if err != nil {
		return 0, err
	}
	return len(ids), nil
}

// fulfillingEvent 是 getFulfillingEvents 的元素形状：eventTime 是 Date，
// isManual 由 source 折算。
type fulfillingEvent struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	EventTime string `json:"eventTime"`
	IsManual  bool   `json:"isManual"`
}

// fulfillingEvents 复刻 getFulfillingEvents：链上去重、保留首次出现的行序
// （TS 用 Set 去重并 push，顺序即查询行序）。
func fulfillingEvents(ctx context.Context, q *db.Queries, itemID int64) ([]fulfillingEvent, error) {
	chain, err := fulfillmentChain(ctx, q, itemID)
	if err != nil {
		return nil, err
	}
	// TS 在 chain.length === 0 时直接返回 []。
	if len(chain) == 0 {
		return []fulfillingEvent{}, nil
	}

	rows, err := q.ListFulfillingEvents(ctx, chain)
	if err != nil {
		return nil, err
	}

	seen := make(map[int64]struct{}, len(rows))
	events := make([]fulfillingEvent, 0, len(rows))
	for _, row := range rows {
		if _, dup := seen[row.ID]; dup {
			continue
		}
		seen[row.ID] = struct{}{}
		events = append(events, fulfillingEvent{
			ID:        row.ID,
			Content:   row.Content,
			EventTime: isoMillis(row.EventTime),
			IsManual:  row.Source == "manual",
		})
	}
	return events, nil
}

// planReferrer 是 findPlanReferrers 的元素形状。
type planReferrer struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	EventTime string `json:"eventTime"`
}

// planReferrers 复刻 findPlanReferrers：读反向索引给出的引用方事件，只读。
func planReferrers(ctx context.Context, q *db.Queries, planItemID int64) ([]planReferrer, error) {
	rows, err := q.ListPlanReferrerEvents(ctx, planItemID)
	if err != nil {
		return nil, err
	}
	refs := make([]planReferrer, 0, len(rows))
	for _, row := range rows {
		refs = append(refs, planReferrer{
			ID:        row.ID,
			Content:   row.Content,
			EventTime: isoMillis(row.EventTime),
		})
	}
	return refs, nil
}

// isoMillis 复刻 `Date.prototype.toISOString()`：UTC、毫秒三位、Z 后缀。
func isoMillis(unixSeconds int64) string {
	return time.Unix(unixSeconds, 0).UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

// nowUnix 是 drizzle 的 timestamp 写入形态：`new Date()` 折成 Unix 秒。
func nowUnix() int64 { return time.Now().Unix() }

// trimJS 复刻 String.prototype.trim()（ECMAScript 空白表）。
func trimJS(s string) string { return jsstr.Trim(s) }

// 复用 jsstr 的空白判定构造「trim 后是否为空」这类判断。
func isBlankContent(s string) bool { return trimJS(s) == "" }
