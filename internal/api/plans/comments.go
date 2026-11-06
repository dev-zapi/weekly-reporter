package plans

import (
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件是 /api/plan-items/{id}/comments 与 .../comments/{commentId} 的 handler，
// 逐条对照 src/app/api/plan-items/[id]/comments/**/route.ts。评论是仅追加的：
// 没有 PUT/PATCH，删一条即唯一变更路径（ADR-0024）。

// listCommentsHandler 复刻 GET /api/plan-items/{id}/comments。
func listCommentsHandler(deps Deps) http.HandlerFunc {
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
			log.Printf("Error fetching plan item comments: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plan item comments", "FETCH_ERROR")
			return
		}

		// 展开区的列表就是徽标的唯一事实源，计数直接从同一个列表派生。
		comments, err := listChainComments(ctx, q, itemID)
		if err != nil {
			log.Printf("Error fetching plan item comments: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch plan item comments", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Comments     []chainComment `json:"comments"`
			CommentCount int            `json:"commentCount"`
		}{Comments: comments, CommentCount: len(comments)})
	}
}

// createCommentHandler 复刻 POST /api/plan-items/{id}/comments。
func createCommentHandler(deps Deps) http.HandlerFunc {
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
			log.Printf("Error creating plan item comment: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create plan item comment", "CREATE_ERROR")
			return
		}

		rawBody, err := decodeJSON(r)
		if err != nil || rawBody == nil {
			log.Printf("Error creating plan item comment: unusable request body: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create plan item comment", "CREATE_ERROR")
			return
		}
		body := objectBody(rawBody)

		content, _ := asString(body["content"])
		if isBlankContent(content) {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Content is required and cannot be empty"})
			return
		}

		// 评论是仅追加的；作者标记只是归因（浏览器 → null，PAT → 自报身份）。
		headers := &requestHeaders{values: r.Header.Values}
		comment, err := createComment(ctx, q, itemID, trimJS(content), deriveCommentAuthor(ctx, headers))
		if err != nil {
			log.Printf("Error creating plan item comment: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create plan item comment", "CREATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, commentJSON{
			ID:         comment.ID,
			PlanItemID: comment.PlanItemID,
			Content:    comment.Content,
			Author:     comment.Author,
			CreatedAt:  isoMillis(comment.CreatedAt),
		})
	}
}

// commentJSON 是 plan_item_comments 行的响应形状。
type commentJSON struct {
	ID         int64   `json:"id"`
	PlanItemID int64   `json:"planItemId"`
	Content    string  `json:"content"`
	Author     *string `json:"author"`
	CreatedAt  string  `json:"createdAt"`
}

// deleteCommentHandler 复刻 DELETE /api/plan-items/{id}/comments/{commentId}。
// 嵌套路径本身就是所有权检查：评论只能从它被写入的条目下到达。
func deleteCommentHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, ok := parseIntBase10(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid item ID"})
			return
		}
		commentID, ok := parseIntBase10(chi.URLParam(r, "commentId"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid comment ID"})
			return
		}

		ctx := r.Context()
		q := deps.Queries

		if _, err := q.GetPlanItem(ctx, itemID); errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Plan item not found"})
			return
		} else if err != nil {
			log.Printf("Error deleting plan item comment: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete plan item comment", "DELETE_ERROR")
			return
		}

		comment, found, err := findComment(ctx, q, commentID)
		if err != nil {
			log.Printf("Error deleting plan item comment: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete plan item comment", "DELETE_ERROR")
			return
		}
		if !found || comment.PlanItemID != itemID {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Comment not found"})
			return
		}

		if err := deleteComment(ctx, q, commentID); err != nil {
			log.Printf("Error deleting plan item comment: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete plan item comment", "DELETE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Deleted bool `json:"deleted"`
		}{Deleted: true})
	}
}
