package plans

import (
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件是 GET /api/plan-items/{id}/fulfillment 的 handler，逐条对照
// src/app/api/plan-items/[id]/fulfillment/route.ts。

// fulfillmentHandler 复刻 GET /api/plan-items/{id}/fulfillment。
func fulfillmentHandler(deps Deps) http.HandlerFunc {
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
			log.Printf("Error fetching fulfilling events: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch fulfilling events", "FETCH_ERROR")
			return
		}

		events, err := fulfillingEvents(ctx, q, itemID)
		if err != nil {
			log.Printf("Error fetching fulfilling events: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch fulfilling events", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Events []fulfillingEvent `json:"events"`
		}{Events: events})
	}
}
