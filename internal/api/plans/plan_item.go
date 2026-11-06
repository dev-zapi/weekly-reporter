package plans

import (
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件是 POST/GET/PUT/DELETE /api/plan-items/{id} 与 POST /api/plan-items 的
// handler，逐条对照 src/app/api/plan-items 下的 route.ts。判定顺序（尤其是
// 「先校验再查存在性」这类细节）按 route.ts 逐行保留。

// createPlanItemHandler 复刻 POST /api/plan-items。
func createPlanItemHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rawBody, err := decodeJSON(r)
		if err != nil || rawBody == nil {
			// route.ts 里 `await request.json()` 或解构抛错都落进 catch。
			log.Printf("Error creating plan item: unusable request body: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
			return
		}
		body := objectBody(rawBody)

		text, _ := asString(body["text"])
		if text == "" || isBlankContent(text) {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Text is required and cannot be empty"})
			return
		}

		// 解构默认值只在属性缺失（undefined）时生效，字段存在但为 null 时按值校验。
		projectScope := "work"
		if raw, present := body["projectScope"]; present {
			value, isString := asString(raw)
			if !isString {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: `projectScope must be "work" or "personal"`})
				return
			}
			projectScope = value
		}
		if projectScope != "work" && projectScope != "personal" {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: `projectScope must be "work" or "personal"`})
			return
		}

		priority := "normal"
		if raw, present := body["priority"]; present {
			priority = "" // 非字符串会在校验里被挡下
			if value, isString := asString(raw); isString {
				priority = value
			}
		}

		var isImportant, isUrgent bool
		rawIsImportant, hasIsImportant := body["isImportant"]
		if hasIsImportant {
			value, isBool := rawIsImportant.(bool)
			isImportant = value && isBool
		}
		rawIsUrgent, hasIsUrgent := body["isUrgent"]
		if hasIsUrgent {
			value, isBool := rawIsUrgent.(bool)
			isUrgent = value && isBool
		}

		// 校验入参形状：只在字段存在时校验（缺失时用默认值）。
		fieldErr := validatePlanItemPriorityFields(
			fieldOf(body, "priority"),
			fieldOf(body, "isImportant"),
			fieldOf(body, "isUrgent"),
		)
		if fieldErr != nil {
			respond.JSON(w, http.StatusBadRequest, fieldErr)
			return
		}

		ctx := r.Context()
		q := deps.Queries

		var targetPlan db.PeriodPlan
		rawPeriodPlanID, hasPeriodPlanID := body["periodPlanId"]

		if !hasPeriodPlanID || !truthyJSON(rawPeriodPlanID) {
			scope, _ := asString(body["scope"])
			if scope != "week" && scope != "month" {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Either periodPlanId or scope is required"})
				return
			}

			var periodStart, periodEnd string
			var monthKey *string

			if scope == "week" {
				rawWeekStart, hasWeekStart := body["weekStart"]
				rawWeekEnd, hasWeekEnd := body["weekEnd"]
				// `!weekStart || !weekEnd`：缺失与假值（null/0/""）都是「没提供」。
				if !hasWeekStart || !hasWeekEnd || !truthyJSON(rawWeekStart) || !truthyJSON(rawWeekEnd) {
					respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "For week scope, weekStart and weekEnd are required"})
					return
				}
				weekStart, weekStartIsString := asString(rawWeekStart)
				weekEnd, weekEndIsString := asString(rawWeekEnd)
				if !weekStartIsString || !weekEndIsString || !isDateString(weekStart) || !isDateString(weekEnd) {
					respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid weekStart or weekEnd format. Use YYYY-MM-DD"})
					return
				}
				// 与 plans 的 GET 不同：这里不归一化到周一，直接采信入参区间。
				periodStart, periodEnd = weekStart, weekEnd
			} else {
				rawMonth, hasMonth := body["month"]
				if !hasMonth || !truthyJSON(rawMonth) {
					respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "For month scope, month parameter is required"})
					return
				}
				month, isString := asString(rawMonth)
				if !isString || !isMonthString(month) {
					respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid month format. Use YYYY-MM"})
					return
				}
				periodStart, periodEnd = monthPeriodRangeByKey(month)
				key := month
				monthKey = &key
			}

			created, err := ensurePeriodPlan(ctx, q, scope, periodStart, periodEnd, monthKey)
			if err != nil {
				log.Printf("Error creating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
				return
			}
			targetPlan = created
		} else {
			planID, convertible := asID(rawPeriodPlanID)
			if !convertible {
				// route.ts 把这个真值原样绑进 where id = ?：布尔/数组/对象让
				// better-sqlite3 在绑定阶段抛错，落进 catch → 500 CREATE_ERROR。
				if unbindableJSON(rawPeriodPlanID) {
					log.Printf("Error creating plan item: periodPlanId is not bindable to an integer: %T", rawPeriodPlanID)
					respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
					return
				}
				respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Period plan not found"})
				return
			}
			plan, err := q.GetPeriodPlan(ctx, planID)
			if errors.Is(err, sql.ErrNoRows) {
				respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Period plan not found"})
				return
			}
			if err != nil {
				log.Printf("Error creating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
				return
			}
			targetPlan = plan
		}

		// 可选父链接按目标计划的周期校验：只有周条目能挂、父条目必须是同月条目。
		// route.ts 先走 validateParentLink 的作用域检查（不查库），再绑父 id，
		// 所以 month 条目的任何 parentItemId 都报作用域错误，而不是 id 形状错误。
		var parentItemID *int64
		if raw, present := body["parentItemId"]; present && raw != nil {
			if msg := parentLinkScopeError(targetPlan.Scope); msg != nil {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: *msg})
				return
			}
			if unbindableJSON(raw) {
				log.Printf("Error creating plan item: parentItemId is not bindable to an integer: %T", raw)
				respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
				return
			}
			id, convertible := asID(raw)
			if !convertible {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "parentItemId does not reference an existing item"})
				return
			}
			validation, err := validateParentLink(ctx, q, targetPlan.Scope, targetPlan.PeriodStart, id)
			if err != nil {
				log.Printf("Error creating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
				return
			}
			if !validation.OK {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: validation.Error})
				return
			}
			parentItemID = &id
		}

		maxPosition, err := q.MaxPlanItemPosition(ctx, targetPlan.ID)
		if err != nil {
			log.Printf("Error creating plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
			return
		}

		now := nowUnix()
		item, err := q.InsertPlanItem(ctx, db.InsertPlanItemParams{
			PeriodPlanID:       targetPlan.ID,
			Text:               trimJS(text),
			Status:             "planned",
			Priority:           priority,
			IsImportant:        boolToInt(isImportant),
			IsUrgent:           boolToInt(isUrgent),
			ProjectScope:       projectScope,
			ParentItemID:       parentItemID,
			DeferredFromItemID: nil,
			Position:           maxPosition + 1,
			CreatedAt:          now,
			UpdatedAt:          now,
		})
		if err != nil {
			log.Printf("Error creating plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create plan item", "CREATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, toPlanItemJSON(item))
	}
}

func boolToInt(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

// itemPeriodJSON 是 GET /api/plan-items/{id} 里的周期身份投影。
type itemPeriodJSON struct {
	ID          int64  `json:"id"`
	Scope       string `json:"scope"`
	PeriodStart string `json:"periodStart"`
	PeriodEnd   string `json:"periodEnd"`
}

// getPlanItemHandler 复刻 GET /api/plan-items/{id}：行 + 周期身份 + 顺延链 + 引用方事件。
func getPlanItemHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, ok := parseIntBase10(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid item ID"})
			return
		}

		ctx := r.Context()
		q := deps.Queries

		item, err := q.GetPlanItem(ctx, itemID)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Plan item not found"})
			return
		}
		if err != nil {
			log.Printf("Error fetching plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plan item", "FETCH_ERROR")
			return
		}

		var period *itemPeriodJSON
		plan, err := q.GetPeriodPlan(ctx, item.PeriodPlanID)
		if err == nil {
			period = &itemPeriodJSON{
				ID:          plan.ID,
				Scope:       plan.Scope,
				PeriodStart: plan.PeriodStart,
				PeriodEnd:   plan.PeriodEnd,
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("Error fetching plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plan item", "FETCH_ERROR")
			return
		}

		chain, err := fulfillmentChain(ctx, q, itemID)
		if err != nil {
			log.Printf("Error fetching plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plan item", "FETCH_ERROR")
			return
		}

		referrers, err := planReferrers(ctx, q, itemID)
		if err != nil {
			log.Printf("Error fetching plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plan item", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			planItemJSON
			Period        *itemPeriodJSON `json:"period"`
			DeferralChain []int64         `json:"deferralChain"`
			Referrers     []planReferrer  `json:"referrers"`
		}{
			planItemJSON:  toPlanItemJSON(item),
			Period:        period,
			DeferralChain: chain,
			Referrers:     referrers,
		})
	}
}

// updatePlanItemHandler 复刻 PUT /api/plan-items/{id}。
//
// 顺序照 route.ts：id 解析 → 字段校验（text/status/priority 组/projectScope）
// → 存在性 → 父链接校验 → 更新。所以「非法 text + 不存在的 id」是 400 而不是 404。
func updatePlanItemHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, ok := parseIntBase10(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid item ID"})
			return
		}

		rawBody, err := decodeJSON(r)
		if err != nil || rawBody == nil {
			log.Printf("Error updating plan item: unusable request body: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
			return
		}
		body := objectBody(rawBody)

		rawText, hasText := body["text"]
		if hasText {
			text, isString := asString(rawText)
			if !isString || isBlankContent(text) {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Text cannot be empty"})
				return
			}
		}

		rawStatus, hasStatus := body["status"]
		if hasStatus {
			status, isString := asString(rawStatus)
			if !isString || indexOf(planItemStatuses, status) < 0 {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{
					Error: "Invalid status. Must be one of: " + joinComma(planItemStatuses),
				})
				return
			}
		}

		// `false` 是真实更新，只有字段缺失才表示「保留旧值」。
		if fieldErr := validatePlanItemPriorityFields(
			fieldOf(body, "priority"),
			fieldOf(body, "isImportant"),
			fieldOf(body, "isUrgent"),
		); fieldErr != nil {
			respond.JSON(w, http.StatusBadRequest, fieldErr)
			return
		}

		rawProjectScope, hasProjectScope := body["projectScope"]
		if hasProjectScope {
			scope, isString := asString(rawProjectScope)
			if !isString || (scope != "work" && scope != "personal") {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: `projectScope must be "work" or "personal"`})
				return
			}
		}

		ctx := r.Context()
		q := deps.Queries

		existing, err := q.GetPlanItem(ctx, itemID)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Plan item not found"})
			return
		}
		if err != nil {
			log.Printf("Error updating plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
			return
		}

		rawParent, hasParent := body["parentItemId"]
		parentProvided := hasParent && rawParent != nil
		var parentItemID *int64
		if parentProvided {
			// route.ts 先查子条目所在计划，再由 validateParentLink 做作用域检查，
			// 之后才把父 id 绑进查询。顺序照着走：month 条目的任何 parentItemId
			// 报作用域错误，不可绑定的形态则是驱动的绑定错误（500）。
			childPlan, err := q.GetPeriodPlan(ctx, existing.PeriodPlanID)
			if errors.Is(err, sql.ErrNoRows) {
				respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Period plan not found"})
				return
			}
			if err != nil {
				log.Printf("Error updating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
				return
			}

			if msg := parentLinkScopeError(childPlan.Scope); msg != nil {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: *msg})
				return
			}
			if unbindableJSON(rawParent) {
				log.Printf("Error updating plan item: parentItemId is not bindable to an integer: %T", rawParent)
				respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
				return
			}

			id, convertible := asID(rawParent)
			if !convertible {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "parentItemId does not reference an existing item"})
				return
			}

			validation, err := validateParentLink(ctx, q, childPlan.Scope, childPlan.PeriodStart, id)
			if err != nil {
				log.Printf("Error updating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
				return
			}
			if !validation.OK {
				respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: validation.Error})
				return
			}
			parentItemID = &id
		}

		updatedAt := nowUnix()
		var updated db.PeriodPlanItem
		if hasParent {
			// parentItemId 显式出现（含 null）才写这一列：null 是「清空链接」的实值。
			params := db.UpdatePlanItemWithParentParams{
				UpdatedAt: updatedAt,
				ID:        itemID,
			}
			if err := applyUpdateFields(&params.Text, &params.Status, &params.Priority,
				&params.IsImportant, &params.IsUrgent, &params.ProjectScope, &params.Position, body); err != nil {
				log.Printf("Error updating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
				return
			}
			// 非 null 时 parentItemID 已校验；null 时直接写 NULL。
			params.ParentItemID = parentItemID
			updated, err = q.UpdatePlanItemWithParent(ctx, params)
		} else {
			params := db.UpdatePlanItemParams{
				UpdatedAt: updatedAt,
				ID:        itemID,
			}
			if err := applyUpdateFields(&params.Text, &params.Status, &params.Priority,
				&params.IsImportant, &params.IsUrgent, &params.ProjectScope, &params.Position, body); err != nil {
				log.Printf("Error updating plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
				return
			}
			updated, err = q.UpdatePlanItem(ctx, params)
		}
		if err != nil {
			log.Printf("Error updating plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update plan item", "UPDATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, toPlanItemJSON(updated))
	}
}

// errPositionUnbindable 表示 route.ts 会把该 position 原始值交给 drizzle，而
// SQLite 驱动在写入阶段拒绝它（null 撞 NOT NULL，布尔/数组/对象在绑定阶段抛错）。
// route.ts 的 catch 把这类错误统一翻成 500 UPDATE_ERROR。
var errPositionUnbindable = errors.New("position is not bindable to an integer column")

// applyUpdateFields 把 body 里出现的字段折成 COALESCE(narg) 参数：
// 未出现的字段保持 nil，SQL 侧即「不改这一列」。
func applyUpdateFields(
	text **string,
	status **string,
	priority **string,
	isImportant **int64,
	isUrgent **int64,
	projectScope **string,
	position **int64,
	body map[string]any,
) error {
	if raw, ok := body["text"]; ok {
		if value, isString := asString(raw); isString {
			trimmed := trimJS(value)
			*text = &trimmed
		}
	}
	if raw, ok := body["status"]; ok {
		if value, isString := asString(raw); isString {
			*status = &value
		}
	}
	if raw, ok := body["priority"]; ok {
		if value, isString := asString(raw); isString {
			*priority = &value
		}
	}
	if raw, ok := body["isImportant"]; ok {
		if value, isBool := raw.(bool); isBool {
			n := boolToInt(value)
			*isImportant = &n
		}
	}
	if raw, ok := body["isUrgent"]; ok {
		if value, isBool := raw.(bool); isBool {
			n := boolToInt(value)
			*isUrgent = &n
		}
	}
	if raw, ok := body["projectScope"]; ok {
		if value, isString := asString(raw); isString {
			*projectScope = &value
		}
	}
	if raw, ok := body["position"]; ok {
		// route.ts 把原始值直接交给 drizzle：null 撞 NOT NULL 约束，布尔/数组/对象
		// 让 better-sqlite3 在绑定阶段抛错，三者都落进 catch → 500 UPDATE_ERROR。
		// 这里显式对齐，而不是静默忽略整列。
		if raw == nil || unbindableJSON(raw) {
			return errPositionUnbindable
		}
		if value, convertible := asID(raw); convertible {
			*position = &value
			return nil
		}
		// 非数字字符串（"abc"）与非整数（5.5）在 route.ts 里按 SQLite 亲和性存成
		// TEXT/REAL 并回 200。Go 的 position 参数是 int64，承载不了这两种形态：
		// 保持原值、状态码仍是 200。这是已裁剪输入集的书面记录，冻结消费者
		// （SPA/skills）只发整数。
	}
	return nil
}

// deletePlanItemHandler 复刻 DELETE /api/plan-items/{id}：一个事务里
// 清子项父链接 → 删入库的兑现关联行 → 级联删评论与引用行 → 删条目。
// deferredFromItemId 链是历史溯源，刻意不动（ADR-0019）。
func deletePlanItemHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, ok := parseIntBase10(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid item ID"})
			return
		}

		ctx := r.Context()
		q := deps.Queries

		if _, err := q.GetPlanItem(ctx, itemID); errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Plan item not found"})
			return
		} else if err != nil {
			log.Printf("Error deleting plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete plan item", "DELETE_ERROR")
			return
		}

		err := q.InTx(ctx, func(tx *db.Queries) error {
			if err := tx.ClearPlanItemChildParents(ctx, db.ClearPlanItemChildParentsParams{
				UpdatedAt:    nowUnix(),
				ParentItemID: &itemID,
			}); err != nil {
				return err
			}
			if err := tx.DeleteEventPlanReferencesByPlanItemID(ctx, itemID); err != nil {
				return err
			}
			if err := deleteCommentsByPlanItem(ctx, tx, itemID); err != nil {
				return err
			}
			return tx.DeletePlanItem(ctx, itemID)
		})
		if err != nil {
			log.Printf("Error deleting plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete plan item", "DELETE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Deleted bool `json:"deleted"`
		}{Deleted: true})
	}
}
