// Package snippets 把语句片段路由（`/api/snippets`、`/api/snippets/{id}`）
// 挂到 chi 的 /api 子路由上。行为逐条对照 src/app/api/snippets 下的 route.ts。
package snippets

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把片段域注册到 /api 子路由上。
//
// 路由表与 src/app/api/snippets 目录一一对应：
//
//	GET    /snippets
//	POST   /snippets
//	DELETE /snippets/{id}
func Mount(r chi.Router, deps Deps) {
	r.Get("/snippets", listHandler(deps))
	r.Post("/snippets", createHandler(deps))
	r.Delete("/snippets/{id}", deleteHandler(deps))
}

// snippetJSON 是 sentence_snippets 行的响应形状：camelCase 键（drizzle 属性名）、
// isBuiltIn 是 boolean（drizzle 的 boolean mode）、时间列是 ISO 字符串
// （timestamp mode 的 Date 经 JSON.stringify）。
type snippetJSON struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	Category  string `json:"category"`
	IsBuiltIn bool   `json:"isBuiltIn"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// isoMillis 复刻 JS `Date.prototype.toISOString()`：UTC、毫秒三位、Z 后缀。
// 数据库存的是 Unix 秒，所以毫秒部分恒为 .000。
func isoMillis(sec int64) string {
	return time.Unix(sec, 0).UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

func toJSON(row db.SentenceSnippet) snippetJSON {
	return snippetJSON{
		ID:        row.ID,
		Content:   row.Content,
		Category:  row.Category,
		IsBuiltIn: row.IsBuiltIn != 0,
		CreatedAt: isoMillis(row.CreatedAt),
		UpdatedAt: isoMillis(row.UpdatedAt),
	}
}

// listHandler 复刻 GET：可选 `category` 过滤；空字符串按 route.ts 的 truthy 判断
// 当作「不过滤」。
func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		category := r.URL.Query().Get("category")

		var rows []db.SentenceSnippet
		var err error
		if category != "" {
			rows, err = deps.Queries.ListSentenceSnippetsByCategory(r.Context(), category)
		} else {
			rows, err = deps.Queries.ListSentenceSnippets(r.Context())
		}
		if err != nil {
			log.Printf("GET /api/snippets error: %v", err)
			failWithDetails(w, "Failed to load snippets", "FETCH_ERROR", err)
			return
		}

		snippets := make([]snippetJSON, 0, len(rows))
		for _, row := range rows {
			snippets = append(snippets, toJSON(row))
		}
		respond.JSON(w, http.StatusOK, struct {
			Snippets []snippetJSON `json:"snippets"`
		}{Snippets: snippets})
	}
}

// createHandler 复刻 POST：内容必填且 ≤500 个 UTF-16 单元；category 可选，
// 非字符串（真值）→ 400；落库时 isBuiltIn 恒为 false。
func createHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeAny(r)
		if err != nil {
			// route.ts 里 request.json() 抛错落进 catch：500 + CREATE_ERROR。
			log.Printf("POST /api/snippets error: %v", err)
			failWithDetails(w, "Failed to create snippet", "CREATE_ERROR", err)
			return
		}
		if body == nil {
			// `body.content` 对 null 抛 TypeError，同样落进 catch。
			log.Printf("POST /api/snippets error: request body is null")
			failWithDetails(w, "Failed to create snippet", "CREATE_ERROR", errors.New("request body is null"))
			return
		}

		object, _ := body.(map[string]any)
		content, _ := object["content"].(string)
		if content == "" {
			// `!body.content || typeof body.content !== 'string'`
			respond.Error(w, http.StatusBadRequest, "Content is required", "INVALID_INPUT")
			return
		}
		// JS 的 string.length 是 UTF-16 码元数，不是字节数。
		if jsstr.UTF16Len(content) > 500 {
			respond.Error(w, http.StatusBadRequest, "Content must be 500 characters or fewer", "INVALID_INPUT")
			return
		}

		category := "General" // route.ts 的 `body.category || 'General'`（不是 schema 默认的 通用）
		if rawCategory, present := object["category"]; present {
			if truthyJSON(rawCategory) {
				str, ok := rawCategory.(string)
				if !ok {
					respond.Error(w, http.StatusBadRequest, "Category must be a string", "INVALID_INPUT")
					return
				}
				category = str
			}
		}

		now := time.Now().Unix()
		row, err := deps.Queries.InsertSentenceSnippet(r.Context(), db.InsertSentenceSnippetParams{
			Content:   content,
			Category:  category,
			IsBuiltIn: 0, // 用户创建的片段永远不是内置
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			log.Printf("POST /api/snippets error: %v", err)
			failWithDetails(w, "Failed to create snippet", "CREATE_ERROR", err)
			return
		}

		respond.JSON(w, http.StatusCreated, struct {
			Snippet snippetJSON `json:"snippet"`
		}{Snippet: toJSON(row)})
	}
}

// deleteHandler 复刻 DELETE /snippets/{id}：
// 非法 id → 400 INVALID_ID；不存在 → 404 NOT_FOUND；内置 → 403 FORBIDDEN。
func deleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseIntBase10(chi.URLParam(r, "id"))
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid snippet ID", "INVALID_ID")
			return
		}

		snippet, err := deps.Queries.GetSentenceSnippet(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Snippet not found", "NOT_FOUND")
			return
		}
		if err != nil {
			log.Printf("DELETE /api/snippets/[id] error: %v", err)
			failWithDetails(w, "Failed to delete snippet", "DELETE_ERROR", err)
			return
		}
		if snippet.IsBuiltIn != 0 {
			respond.Error(w, http.StatusForbidden, "Built-in snippets cannot be deleted", "FORBIDDEN")
			return
		}

		if err := deps.Queries.DeleteSentenceSnippet(r.Context(), id); err != nil {
			log.Printf("DELETE /api/snippets/[id] error: %v", err)
			failWithDetails(w, "Failed to delete snippet", "DELETE_ERROR", err)
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Message string `json:"message"`
		}{Message: "Snippet deleted successfully"})
	}
}

// failWithDetails 写 route.ts 的 500 形状：{error, code, details}，
// details 是 String(error)（诊断字段，文本不构成契约）。
func failWithDetails(w http.ResponseWriter, message, code string, err error) {
	respond.JSON(w, http.StatusInternalServerError, struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details string `json:"details"`
	}{Error: message, Code: code, Details: "Error: " + err.Error()})
}

// decodeAny 复刻 `await request.json()`：解析失败与 route.ts 一样是错误。
// json.Unmarshal 同时拒绝尾随垃圾，并把数字折成 float64（与 JSON.parse 的 double 一致）。
func decodeAny(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}

// truthyJSON 复刻 JS 的真值判断，用于 `body.category` 这类短路条件。
func truthyJSON(v any) bool {
	switch value := v.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case float64:
		return value != 0
	case []any, map[string]any:
		return true
	}
	return false
}

// parseIntBase10 复刻 JS `parseInt(value, 10)`：语义唯一实现见 jsparse.ParseInt10。
func parseIntBase10(value string) (int64, bool) { return jsparse.ParseInt10(value) }
