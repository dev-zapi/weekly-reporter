// Package plans 把周期计划域路由挂到 chi 的 /api 子路由上。行为逐条对照
// src/app/api/plans、src/app/api/plan-items 下的 route.ts，服务端逻辑移植自
// src/lib/plan-items.ts、src/lib/plan-references/、src/lib/plan-item-comments/
// 与 src/lib/periods.ts（ADR-0018/0019/0023/0024）。
package plans

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把计划域注册到 /api 子路由上。
//
// 路由表与 src/app/api/{plans,plan-items} 目录一一对应：
//
//	GET    /plans
//	POST   /plan-items
//	GET    /plan-items/{id}
//	PUT    /plan-items/{id}
//	DELETE /plan-items/{id}
//	GET    /plan-items/{id}/comments
//	POST   /plan-items/{id}/comments
//	DELETE /plan-items/{id}/comments/{commentId}
//	POST   /plan-items/{id}/defer
//	GET    /plan-items/{id}/fulfillment
//
// 全部扁平注册：chi 按段数匹配，{id} 不会遮蔽更长的子路由。
func Mount(r chi.Router, deps Deps) {
	r.Get("/plans", listPlansHandler(deps))
	r.Post("/plan-items", createPlanItemHandler(deps))
	r.Get("/plan-items/{id}", getPlanItemHandler(deps))
	r.Put("/plan-items/{id}", updatePlanItemHandler(deps))
	r.Delete("/plan-items/{id}", deletePlanItemHandler(deps))
	r.Get("/plan-items/{id}/comments", listCommentsHandler(deps))
	r.Post("/plan-items/{id}/comments", createCommentHandler(deps))
	r.Delete("/plan-items/{id}/comments/{commentId}", deleteCommentHandler(deps))
	r.Post("/plan-items/{id}/defer", deferPlanItemHandler(deps))
	r.Get("/plan-items/{id}/fulfillment", fulfillmentHandler(deps))
}

// planJSON 是 period_plans 行的响应形状：键名按 drizzle 属性名，时间列是
// Date 经 JSON.stringify 得到的 ISO 字符串。
type planJSON struct {
	ID          int64   `json:"id"`
	Scope       string  `json:"scope"`
	PeriodStart string  `json:"periodStart"`
	PeriodEnd   string  `json:"periodEnd"`
	MonthKey    *string `json:"monthKey"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

func toPlanJSON(row db.PeriodPlan) planJSON {
	return planJSON{
		ID:          row.ID,
		Scope:       row.Scope,
		PeriodStart: row.PeriodStart,
		PeriodEnd:   row.PeriodEnd,
		MonthKey:    row.MonthKey,
		CreatedAt:   isoMillis(row.CreatedAt),
		UpdatedAt:   isoMillis(row.UpdatedAt),
	}
}

// planItemJSON 是 period_plan_items 行的响应形状。
type planItemJSON struct {
	ID                 int64  `json:"id"`
	PeriodPlanID       int64  `json:"periodPlanId"`
	Text               string `json:"text"`
	Status             string `json:"status"`
	Priority           string `json:"priority"`
	IsImportant        bool   `json:"isImportant"`
	IsUrgent           bool   `json:"isUrgent"`
	ProjectScope       string `json:"projectScope"`
	ParentItemID       *int64 `json:"parentItemId"`
	DeferredFromItemID *int64 `json:"deferredFromItemId"`
	Position           int64  `json:"position"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
}

func toPlanItemJSON(row db.PeriodPlanItem) planItemJSON {
	return planItemJSON{
		ID:                 row.ID,
		PeriodPlanID:       row.PeriodPlanID,
		Text:               row.Text,
		Status:             row.Status,
		Priority:           row.Priority,
		IsImportant:        row.IsImportant != 0,
		IsUrgent:           row.IsUrgent != 0,
		ProjectScope:       row.ProjectScope,
		ParentItemID:       row.ParentItemID,
		DeferredFromItemID: row.DeferredFromItemID,
		Position:           row.Position,
		CreatedAt:          isoMillis(row.CreatedAt),
		UpdatedAt:          isoMillis(row.UpdatedAt),
	}
}

// weekItemJSON 是 week 作用域的条目：行字段 + 兑现数 + 计划侧评论数。
type weekItemJSON struct {
	planItemJSON
	FulfillmentCount int `json:"fulfillmentCount"`
	CommentCount     int `json:"commentCount"`
}

// childItemJSON 是月度回看树里挂在月条目下的周条目。
type childItemJSON struct {
	ID               int64  `json:"id"`
	Text             string `json:"text"`
	Status           string `json:"status"`
	ProjectScope     string `json:"projectScope"`
	Priority         string `json:"priority"`
	IsImportant      bool   `json:"isImportant"`
	IsUrgent         bool   `json:"isUrgent"`
	WeekPeriodStart  string `json:"weekPeriodStart"`
	WeekPeriodEnd    string `json:"weekPeriodEnd"`
	FulfillmentCount int    `json:"fulfillmentCount"`
	CommentCount     int    `json:"commentCount"`
}

// inheritedChildItemJSON 是顺延祖先月条目下挂的周条目（只读分组）。
type inheritedChildItemJSON struct {
	ID               int64  `json:"id"`
	Text             string `json:"text"`
	Status           string `json:"status"`
	ProjectScope     string `json:"projectScope"`
	Priority         string `json:"priority"`
	IsImportant      bool   `json:"isImportant"`
	IsUrgent         bool   `json:"isUrgent"`
	WeekPeriodStart  string `json:"weekPeriodStart"`
	WeekPeriodEnd    string `json:"weekPeriodEnd"`
	FulfillmentCount int    `json:"fulfillmentCount"`
}

// inheritedChildGroupJSON 是「顺延祖先月条目的子项」分组。
type inheritedChildGroupJSON struct {
	AncestorItemID int64                    `json:"ancestorItemId"`
	AncestorMonth  string                   `json:"ancestorMonth"`
	Items          []inheritedChildItemJSON `json:"items"`
}

// monthItemJSON 是月度回看的月条目：行字段 + 直接/间接兑现数 + 评论数 + 子项树。
type monthItemJSON struct {
	planItemJSON
	DirectFulfillmentCount   int                       `json:"directFulfillmentCount"`
	IndirectFulfillmentCount int                       `json:"indirectFulfillmentCount"`
	FulfillmentCount         int                       `json:"fulfillmentCount"`
	CommentCount             int                       `json:"commentCount"`
	ChildItems               []childItemJSON           `json:"childItems"`
	InheritedChildGroups     []inheritedChildGroupJSON `json:"inheritedChildGroups"`
}

// candidateItemJSON 是可挂接候选条目的最小投影。
type candidateItemJSON struct {
	ID           int64  `json:"id"`
	Text         string `json:"text"`
	Status       string `json:"status"`
	ProjectScope string `json:"projectScope"`
	Priority     string `json:"priority"`
	IsImportant  bool   `json:"isImportant"`
	IsUrgent     bool   `json:"isUrgent"`
}

// attachCandidateGroupJSON 是按周分组的可挂接条目。
type attachCandidateGroupJSON struct {
	PeriodStart string              `json:"periodStart"`
	PeriodEnd   string              `json:"periodEnd"`
	Items       []candidateItemJSON `json:"items"`
}

// listPlansHandler 复刻 GET /api/plans：week 返回扁平列表（含兑现/评论计数），
// month 返回月度回看树（含直接/间接兑现与可挂接候选）。
func listPlansHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		scope := query.Get("scope")
		dateParam := query.Get("date")
		weekStart := query.Get("weekStart")
		weekEnd := query.Get("weekEnd")
		month := query.Get("month")

		if scope != "week" && scope != "month" {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{
				Error: `Invalid or missing scope parameter. Must be "week" or "month"`,
			})
			return
		}

		var periodStart, periodEnd string

		if scope == "week" {
			switch {
			case dateParam != "":
				date, ok := parseOffsetInstant(dateParam)
				if !ok {
					invalidInstantParam(w, "date", "INVALID_DATE")
					return
				}
				periodStart, periodEnd = weekPeriodRange(date)
			case weekStart != "" && weekEnd != "":
				startInstant, startOK := parseOffsetInstant(weekStart)
				if !startOK {
					invalidInstantParam(w, "weekStart", "INVALID_WEEK_START")
					return
				}
				if _, endOK := parseOffsetInstant(weekEnd); !endOK {
					invalidInstantParam(w, "weekEnd", "INVALID_WEEK_END")
					return
				}
				// 以 weekStart 归一到周一开头的规范周，不信任原始成对区间：
				// 周内任意日期都解析到同一条计划行。日历按 weekStart 自带偏移读。
				periodStart, periodEnd = weekPeriodRange(startInstant)
			default:
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "For week scope, provide either date or weekStart+weekEnd"})
				return
			}
		} else {
			switch {
			case month != "":
				instant, ok := parseOffsetInstant(month)
				if !ok {
					invalidInstantParam(w, "month", "INVALID_MONTH")
					return
				}
				_, periodStart, periodEnd = monthPeriodRange(instant)
			case dateParam != "":
				date, ok := parseOffsetInstant(dateParam)
				if !ok {
					invalidInstantParam(w, "date", "INVALID_DATE")
					return
				}
				_, periodStart, periodEnd = monthPeriodRange(date)
			default:
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "For month scope, provide either month or date"})
				return
			}
		}

		ctx := r.Context()
		q := deps.Queries

		planRow, found, err := getPlanByPeriod(ctx, q, scope, periodStart, periodEnd)
		if err != nil {
			log.Printf("Error fetching plans: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plans", "FETCH_ERROR")
			return
		}

		if !found {
			if scope == "month" {
				candidates, err := attachCandidates(ctx, q, periodStart, periodEnd)
				if err != nil {
					log.Printf("Error fetching plans: %v", err)
					respond.Error(w, http.StatusInternalServerError, "Failed to fetch plans", "FETCH_ERROR")
					return
				}
				respond.JSON(w, http.StatusOK, struct {
					Plan             *planJSON                  `json:"plan"`
					Items            []monthItemJSON            `json:"items"`
					AttachCandidates []attachCandidateGroupJSON `json:"attachCandidates"`
				}{Plan: nil, Items: []monthItemJSON{}, AttachCandidates: candidates})
				return
			}
			respond.JSON(w, http.StatusOK, struct {
				Plan  *planJSON      `json:"plan"`
				Items []weekItemJSON `json:"items"`
			}{Plan: nil, Items: []weekItemJSON{}})
			return
		}

		items, err := q.ListPlanItemsByPlanID(ctx, planRow.ID)
		if err != nil {
			log.Printf("Error fetching plans: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plans", "FETCH_ERROR")
			return
		}

		if scope == "month" {
			reviewItems, candidates, err := composeMonthReview(ctx, q, planRow, items)
			if err != nil {
				log.Printf("Error fetching plans: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to fetch plans", "FETCH_ERROR")
				return
			}
			respond.JSON(w, http.StatusOK, struct {
				Plan             planJSON                   `json:"plan"`
				Items            []monthItemJSON            `json:"items"`
				AttachCandidates []attachCandidateGroupJSON `json:"attachCandidates"`
			}{Plan: toPlanJSON(planRow), Items: reviewItems, AttachCandidates: candidates})
			return
		}

		// week：每个条目补链式聚合的兑现数与评论数。两者都是链式聚合：
		// 顺延后继显示祖先的工作与笔记，与它展开的分区一致。
		withCounts := make([]weekItemJSON, 0, len(items))
		for _, item := range items {
			fulfillment, err := fulfillmentCount(ctx, q, item.ID)
			if err != nil {
				log.Printf("Error fetching plans: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to fetch plans", "FETCH_ERROR")
				return
			}
			comments, err := chainCommentCount(ctx, q, item.ID)
			if err != nil {
				log.Printf("Error fetching plans: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to fetch plans", "FETCH_ERROR")
				return
			}
			withCounts = append(withCounts, weekItemJSON{
				planItemJSON:     toPlanItemJSON(item),
				FulfillmentCount: fulfillment,
				CommentCount:     comments,
			})
		}
		respond.JSON(w, http.StatusOK, struct {
			Plan  planJSON       `json:"plan"`
			Items []weekItemJSON `json:"items"`
		}{Plan: toPlanJSON(planRow), Items: withCounts})
	}
}

// getPlanByPeriod 复刻 `select ... where scope/periodStart/periodEnd` + `plan[0]`。
func getPlanByPeriod(ctx context.Context, q *db.Queries, scope, periodStart, periodEnd string) (db.PeriodPlan, bool, error) {
	row, err := q.GetPeriodPlanByPeriod(ctx, db.GetPeriodPlanByPeriodParams{
		Scope:       scope,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return db.PeriodPlan{}, false, nil
	}
	if err != nil {
		return db.PeriodPlan{}, false, err
	}
	return row, true, nil
}

// monthWeeks 复刻 getMonthWeeks：归属某月的周一开头周（按 period_start 升序）。
func monthWeeks(ctx context.Context, q *db.Queries, monthStart, monthEnd string) ([]db.PeriodPlan, error) {
	return q.ListWeekPlansStartingInRange(ctx, db.ListWeekPlansStartingInRangeParams{
		PeriodStart:   monthStart,
		PeriodStart_2: monthEnd,
	})
}

// weekItems 复刻 getWeekItems：给定周计划 id 取全部条目（空列表直接返回 []）。
func weekItems(ctx context.Context, q *db.Queries, weekPlanIDs []int64) ([]db.PeriodPlanItem, error) {
	if len(weekPlanIDs) == 0 {
		return []db.PeriodPlanItem{}, nil
	}
	return q.ListPlanItemsByPlanIDs(ctx, weekPlanIDs)
}

// attachCandidates 复刻 getAttachCandidates：月内各周的无父条目，按周分组。
func attachCandidates(ctx context.Context, q *db.Queries, monthStart, monthEnd string) ([]attachCandidateGroupJSON, error) {
	weekPlans, err := monthWeeks(ctx, q, monthStart, monthEnd)
	if err != nil {
		return nil, err
	}
	items, err := weekItems(ctx, q, planIDs(weekPlans))
	if err != nil {
		return nil, err
	}
	return buildAttachCandidates(weekPlans, items), nil
}

func planIDs(plans []db.PeriodPlan) []int64 {
	ids := make([]int64, 0, len(plans))
	for _, plan := range plans {
		ids = append(ids, plan.ID)
	}
	return ids
}

// buildAttachCandidates 复刻 buildAttachCandidates：只收无父条目（parentItemId 为
// null），空周整组丢弃（不留死分组）。
func buildAttachCandidates(weekPlans []db.PeriodPlan, items []db.PeriodPlanItem) []attachCandidateGroupJSON {
	groups := make([]attachCandidateGroupJSON, 0, len(weekPlans))
	for _, weekPlan := range weekPlans {
		rows := make([]db.PeriodPlanItem, 0)
		for _, item := range items {
			if item.PeriodPlanID == weekPlan.ID && item.ParentItemID == nil {
				rows = append(rows, item)
			}
		}
		sort.SliceStable(rows, func(i, j int) bool {
			return compareByPriorityThenPosition(rows[i], rows[j]) < 0
		})

		if len(rows) == 0 {
			continue
		}
		group := attachCandidateGroupJSON{
			PeriodStart: weekPlan.PeriodStart,
			PeriodEnd:   weekPlan.PeriodEnd,
			Items:       make([]candidateItemJSON, 0, len(rows)),
		}
		for _, row := range rows {
			group.Items = append(group.Items, candidateItemJSON{
				ID:           row.ID,
				Text:         row.Text,
				Status:       row.Status,
				ProjectScope: row.ProjectScope,
				Priority:     row.Priority,
				IsImportant:  row.IsImportant != 0,
				IsUrgent:     row.IsUrgent != 0,
			})
		}
		groups = append(groups, group)
	}
	return groups
}

// priorityRank 复刻 priorityRank：未知值排在所有已知优先级之后（与 SQL CASE 一致）。
func priorityRank(priority string) int {
	index := indexOf(planItemPriorities, priority)
	if index < 0 {
		return len(planItemPriorities)
	}
	return index
}

// compareByPriorityThenPosition 复刻 compareByPriorityThenPosition。
func compareByPriorityThenPosition(a, b db.PeriodPlanItem) int {
	if diff := priorityRank(a.Priority) - priorityRank(b.Priority); diff != 0 {
		return diff
	}
	if a.Position != b.Position {
		if a.Position < b.Position {
			return -1
		}
		return 1
	}
	switch {
	case a.ID < b.ID:
		return -1
	case a.ID > b.ID:
		return 1
	}
	return 0
}

// composeMonthReview 复刻 composeMonthReview：
//   - 月条目带自己的挂接周条目（含周归属）
//   - 组合兑现 = 直接（引用月条目，链式聚合）+ 间接（经挂接周条目，逐子链聚合）；
//     两组来自同一个去重事件并集，重叠证据只算一次
//   - 顺延的月后继还聚合其祖先月条目挂的周条目（与周条目顺延规则镜像），
//     以带标签的只读分组暴露
//   - 可挂接候选 = 月内各周无父条目，按周分组；无父条目永不出现在树里
func composeMonthReview(ctx context.Context, q *db.Queries, planRow db.PeriodPlan, monthItems []db.PeriodPlanItem) ([]monthItemJSON, []attachCandidateGroupJSON, error) {
	weekPlans, err := monthWeeks(ctx, q, planRow.PeriodStart, planRow.PeriodEnd)
	if err != nil {
		return nil, nil, err
	}
	weekRows, err := weekItems(ctx, q, planIDs(weekPlans))
	if err != nil {
		return nil, nil, err
	}
	weekPlanByID := make(map[int64]db.PeriodPlan, len(weekPlans))
	for _, plan := range weekPlans {
		weekPlanByID[plan.ID] = plan
	}

	childrenByParent := make(map[int64][]db.PeriodPlanItem)
	for _, weekItem := range weekRows {
		if weekItem.ParentItemID == nil {
			continue
		}
		childrenByParent[*weekItem.ParentItemID] = append(childrenByParent[*weekItem.ParentItemID], weekItem)
	}

	items := make([]monthItemJSON, 0, len(monthItems))
	for _, item := range monthItems {
		childRows := append([]db.PeriodPlanItem{}, childrenByParent[item.ID]...)
		sort.SliceStable(childRows, func(i, j int) bool {
			return compareByPriorityThenPosition(childRows[i], childRows[j]) < 0
		})

		// 顺延镜像：后继不只聚合自己的挂接周条目，也聚合它被顺延来的月条目
		// 所挂的周条目。子项自身从不迁移。
		chain, err := fulfillmentChain(ctx, q, item.ID)
		if err != nil {
			return nil, nil, err
		}
		ancestorIDs := make([]int64, 0, len(chain))
		for _, id := range chain {
			if id != item.ID {
				ancestorIDs = append(ancestorIDs, id)
			}
		}
		ancestorChildren, err := itemsByParentIDs(ctx, q, ancestorIDs)
		if err != nil {
			return nil, nil, err
		}

		commentCount, err := chainCommentCount(ctx, q, item.ID)
		if err != nil {
			return nil, nil, err
		}

		childItems := make([]childItemJSON, 0, len(childRows))
		for _, child := range childRows {
			weekPlan := weekPlanByID[child.PeriodPlanID]
			fulfillment, err := fulfillmentCount(ctx, q, child.ID)
			if err != nil {
				return nil, nil, err
			}
			childComments, err := chainCommentCount(ctx, q, child.ID)
			if err != nil {
				return nil, nil, err
			}
			childItems = append(childItems, childItemJSON{
				ID:               child.ID,
				Text:             child.Text,
				Status:           child.Status,
				ProjectScope:     child.ProjectScope,
				Priority:         child.Priority,
				IsImportant:      child.IsImportant != 0,
				IsUrgent:         child.IsUrgent != 0,
				WeekPeriodStart:  weekPlan.PeriodStart,
				WeekPeriodEnd:    weekPlan.PeriodEnd,
				FulfillmentCount: fulfillment,
				CommentCount:     childComments,
			})
		}

		inheritedGroups, err := composeInheritedChildGroups(ctx, q, ancestorIDs, ancestorChildren)
		if err != nil {
			return nil, nil, err
		}

		// 整个组合徽标用同一个去重事件并集：直接证据引用月顺延链，间接证据
		// 引用任何挂接周条目（自己的或继承的）或那些条目各自链上的链接。
		// 逐链计数再相加会把重叠证据算两次。
		indirectItemIDs, err := distinctItemIDs(ctx, q, append(append([]db.PeriodPlanItem{}, childRows...), ancestorChildren...))
		if err != nil {
			return nil, nil, err
		}
		directEventIDs, err := fulfillmentEventIDs(ctx, q, chain)
		if err != nil {
			return nil, nil, err
		}
		indirectEventIDs, err := fulfillmentEventIDs(ctx, q, indirectItemIDs)
		if err != nil {
			return nil, nil, err
		}
		indirectFulfillmentCount := 0
		for eventID := range indirectEventIDs {
			if _, direct := directEventIDs[eventID]; !direct {
				indirectFulfillmentCount++
			}
		}
		directFulfillmentCount := len(directEventIDs)

		items = append(items, monthItemJSON{
			planItemJSON:             toPlanItemJSON(item),
			DirectFulfillmentCount:   directFulfillmentCount,
			IndirectFulfillmentCount: indirectFulfillmentCount,
			FulfillmentCount:         directFulfillmentCount + indirectFulfillmentCount,
			CommentCount:             commentCount,
			ChildItems:               childItems,
			InheritedChildGroups:     inheritedGroups,
		})
	}

	return items, buildAttachCandidates(weekPlans, weekRows), nil
}

// itemsByParentIDs 复刻 inArray(periodPlanItems.parentItemId, ancestorIds)：
// 空列表直接返回 []（drizzle 的 inArray 空集不作为查询发出）。
// 列本身可空，sqlc 因此把 slice 元素生成成 *int64。
func itemsByParentIDs(ctx context.Context, q *db.Queries, parentIDs []int64) ([]db.PeriodPlanItem, error) {
	if len(parentIDs) == 0 {
		return []db.PeriodPlanItem{}, nil
	}
	pointers := make([]*int64, 0, len(parentIDs))
	for _, id := range parentIDs {
		value := id
		pointers = append(pointers, &value)
	}
	return q.ListPlanItemsByParentIDs(ctx, pointers)
}

// composeInheritedChildGroups 复刻 composeInheritedChildGroups：把祖先月条目挂的
// 周条目按祖先分组；后继以带标签的只读分组渲染，证据可原地查看。
func composeInheritedChildGroups(ctx context.Context, q *db.Queries, ancestorIDs []int64, ancestorChildren []db.PeriodPlanItem) ([]inheritedChildGroupJSON, error) {
	groups := make([]inheritedChildGroupJSON, 0)
	if len(ancestorChildren) == 0 {
		return groups, nil
	}

	ancestorRows, err := q.ListPlanItemPlanIDs(ctx, ancestorIDs)
	if err != nil {
		return nil, err
	}
	ancestorPlanIDs := make([]int64, 0, len(ancestorRows))
	for _, row := range ancestorRows {
		ancestorPlanIDs = append(ancestorPlanIDs, row.PeriodPlanID)
	}
	ancestorPlans, err := listPlansByIDs(ctx, q, ancestorPlanIDs)
	if err != nil {
		return nil, err
	}
	planByID := make(map[int64]db.PeriodPlan, len(ancestorPlans))
	for _, plan := range ancestorPlans {
		planByID[plan.ID] = plan
	}
	monthByAncestorID := make(map[int64]string, len(ancestorRows))
	for _, row := range ancestorRows {
		plan := planByID[row.PeriodPlanID]
		monthByAncestorID[row.ID] = monthOrStart(plan.MonthKey, plan.PeriodStart)
	}

	childPlanIDs := make([]int64, 0, len(ancestorChildren))
	for _, child := range ancestorChildren {
		childPlanIDs = append(childPlanIDs, child.PeriodPlanID)
	}
	childWeekPlans, err := listPlansByIDs(ctx, q, childPlanIDs)
	if err != nil {
		return nil, err
	}
	childWeekPlanByID := make(map[int64]db.PeriodPlan, len(childWeekPlans))
	for _, plan := range childWeekPlans {
		childWeekPlanByID[plan.ID] = plan
	}

	childrenByParent := make(map[int64][]db.PeriodPlanItem)
	for _, child := range ancestorChildren {
		if child.ParentItemID == nil {
			continue
		}
		childrenByParent[*child.ParentItemID] = append(childrenByParent[*child.ParentItemID], child)
	}

	for _, ancestorID := range ancestorIDs {
		rows := append([]db.PeriodPlanItem{}, childrenByParent[ancestorID]...)
		if len(rows) == 0 {
			continue
		}
		sort.SliceStable(rows, func(i, j int) bool {
			return compareByPriorityThenPosition(rows[i], rows[j]) < 0
		})

		group := inheritedChildGroupJSON{
			AncestorItemID: ancestorID,
			AncestorMonth:  monthByAncestorID[ancestorID],
			Items:          make([]inheritedChildItemJSON, 0, len(rows)),
		}
		for _, child := range rows {
			fulfillment, err := fulfillmentCount(ctx, q, child.ID)
			if err != nil {
				return nil, err
			}
			weekPlan := childWeekPlanByID[child.PeriodPlanID]
			group.Items = append(group.Items, inheritedChildItemJSON{
				ID:               child.ID,
				Text:             child.Text,
				Status:           child.Status,
				ProjectScope:     child.ProjectScope,
				Priority:         child.Priority,
				IsImportant:      child.IsImportant != 0,
				IsUrgent:         child.IsUrgent != 0,
				WeekPeriodStart:  weekPlan.PeriodStart,
				WeekPeriodEnd:    weekPlan.PeriodEnd,
				FulfillmentCount: fulfillment,
			})
		}
		groups = append(groups, group)
	}
	return groups, nil
}

// listPlansByIDs 复刻 inArray(periodPlans.id, ids)：空列表 → []。
func listPlansByIDs(ctx context.Context, q *db.Queries, ids []int64) ([]db.PeriodPlan, error) {
	if len(ids) == 0 {
		return []db.PeriodPlan{}, nil
	}
	return q.ListPeriodPlansByIDs(ctx, ids)
}

// distinctItemIDs 复刻
// `Array.from(new Set((await Promise.all(children.map(c => getFulfillmentChain(c.id)))).flat()))`。
func distinctItemIDs(ctx context.Context, q *db.Queries, children []db.PeriodPlanItem) ([]int64, error) {
	seen := make(map[int64]struct{})
	ids := make([]int64, 0)
	for _, child := range children {
		chain, err := fulfillmentChain(ctx, q, child.ID)
		if err != nil {
			return nil, err
		}
		for _, id := range chain {
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	return ids, nil
}
