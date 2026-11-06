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

// 本文件是 POST /api/plan-items/{id}/defer 的 handler，逐条对照
// src/app/api/plan-items/[id]/defer/route.ts。

// deferPlanItemHandler 复刻 POST /api/plan-items/{id}/defer：把未完成条目
// 顺延到同作用域的下一个周期（新建条目 + 原条目置 deferred）。
// 优先级与两个标志随条目走，只有 status 重置。
func deferPlanItemHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, ok := parseIntBase10(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid item ID"})
			return
		}

		ctx := r.Context()
		q := deps.Queries

		originalItem, err := q.GetPlanItem(ctx, itemID)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Plan item not found"})
			return
		}
		if err != nil {
			log.Printf("Error deferring plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
			return
		}

		// 只有未完成条目可以顺延：done/cancelled/deferred 都不是下期的候选。
		if originalItem.Status != "planned" && originalItem.Status != "in_progress" {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Only planned or in_progress items can be deferred"})
			return
		}

		originalPlan, err := q.GetPeriodPlan(ctx, originalItem.PeriodPlanID)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Period plan not found"})
			return
		}
		if err != nil {
			log.Printf("Error deferring plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
			return
		}

		var nextStart, nextEnd string
		var nextMonthKey *string
		if originalPlan.Scope == "week" {
			nextStart, nextEnd = nextWeekPeriodRange(originalPlan.PeriodStart)
		} else {
			key, start, end := nextMonthPeriodRange(monthOrStart(originalPlan.MonthKey, originalPlan.PeriodStart))
			nextStart, nextEnd = start, end
			nextMonthKey = &key
		}

		nextPlan, err := ensurePeriodPlan(ctx, q, originalPlan.Scope, nextStart, nextEnd, nextMonthKey)
		if err != nil {
			log.Printf("Error deferring plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
			return
		}

		// 父链接只在它对新周仍满足「月包含周开始日」时才继承；否则静默丢弃，
		// 让顺延本身照样成功。
		var inheritedParentItemID *int64
		if originalItem.ParentItemID != nil {
			validation, err := validateParentLink(ctx, q, originalPlan.Scope, nextStart, *originalItem.ParentItemID)
			if err != nil {
				log.Printf("Error deferring plan item: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
				return
			}
			if validation.OK {
				inheritedParentItemID = originalItem.ParentItemID
			}
		}

		maxPosition, err := q.MaxPlanItemPosition(ctx, nextPlan.ID)
		if err != nil {
			log.Printf("Error deferring plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
			return
		}

		now := nowUnix()
		newItem, err := q.InsertPlanItem(ctx, db.InsertPlanItemParams{
			PeriodPlanID:       nextPlan.ID,
			Text:               originalItem.Text,
			Status:             "planned",
			Priority:           originalItem.Priority,
			IsImportant:        originalItem.IsImportant,
			IsUrgent:           originalItem.IsUrgent,
			ProjectScope:       originalItem.ProjectScope,
			ParentItemID:       inheritedParentItemID,
			DeferredFromItemID: &originalItem.ID,
			Position:           maxPosition + 1,
			CreatedAt:          now,
			UpdatedAt:          now,
		})
		if err != nil {
			log.Printf("Error deferring plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
			return
		}

		deferred := "deferred"
		if _, err := q.UpdatePlanItem(ctx, db.UpdatePlanItemParams{
			Status:    &deferred,
			UpdatedAt: now,
			ID:        originalItem.ID,
		}); err != nil {
			log.Printf("Error deferring plan item: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to defer plan item", "DEFER_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, toPlanItemJSON(newItem))
	}
}
