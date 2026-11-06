// Package tags 把标签域路由（`GET/DELETE /api/tags`、`POST /api/tags/rename`）
// 挂到 chi 的 /api 子路由上。行为逐条对照 src/app/api/tags 下的 route.ts，
// 服务端逻辑移植自 src/lib/tags（parse.ts 的词边界规则 + db.ts 的双存储维护）。
package tags

import (
	"context"
	"log"
	"net/http"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把标签域注册到 /api 子路由上。
//
// 路由表与 src/app/api/tags 目录一一对应：
//
//	GET    /tags
//	DELETE /tags
//	POST   /tags/rename
func Mount(r chi.Router, deps Deps) {
	r.Get("/tags", listHandler(deps))
	r.Delete("/tags", deleteHandler(deps))
	r.Post("/tags/rename", renameHandler(deps))
}

// tagCount 是 GET /api/tags 的元素形状：SELECT 别名 name/count（listTagsWithCounts
// 的 select 投影），不是列名。
type tagCount struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// listHandler 复刻 src/app/api/tags/route.ts 的 GET：返回 {tags: [{name, count}]}，
// 按 name 升序（SQLite BINARY 排序，与 drizzle 的 asc() 一致）。
func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := deps.Queries.ListTagsWithCounts(r.Context())
		if err != nil {
			log.Printf("Error fetching tags: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch tags", "FETCH_ERROR")
			return
		}

		// 空结果必须是 [] 而不是 null（客户端直接 map）。
		tags := make([]tagCount, 0, len(rows))
		for _, row := range rows {
			tags = append(tags, tagCount{Name: row.Name, Count: row.TagCount})
		}
		respond.JSON(w, http.StatusOK, struct {
			Tags []tagCount `json:"tags"`
		}{Tags: tags})
	}
}

// deleteHandler 复刻 DELETE：`name` 缺失或不合字符集 → 400 INVALID_TAG_NAME，
// 否则全局移除（内容文本 + 关联表两侧，ADR-0012），回 {removed}。
func deleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if name == "" || !IsValidTagName(name) {
			respond.Error(w, http.StatusBadRequest, "Invalid tag name", "INVALID_TAG_NAME")
			return
		}

		removed, err := removeTagGlobally(r.Context(), deps.Queries, name)
		if err != nil {
			log.Printf("Error removing tag: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to remove tag", "DELETE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			Removed int64 `json:"removed"`
		}{Removed: removed})
	}
}

// renameHandler 复刻 POST /api/tags/rename：校验失败回 400 + VALIDATION_ERROR
// 与 zod 形状的 details.issues；成功回 {eventsUpdated, merged}。
func renameHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSONBody(r)
		if err != nil {
			// route.ts 里 request.json() 抛错落进 catch：500 + RENAME_ERROR。
			log.Printf("Error renaming tag: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to rename tag", "RENAME_ERROR")
			return
		}

		from, to, issues := validateRenameBody(body)
		if len(issues) > 0 {
			respond.JSON(w, http.StatusBadRequest, struct {
				Error   string       `json:"error"`
				Code    string       `json:"code"`
				Details issueDetails `json:"details"`
			}{Error: "Validation failed", Code: "VALIDATION_ERROR", Details: issueDetails{Issues: issues}})
			return
		}

		result, err := renameTagGlobally(r.Context(), deps.Queries, from, to)
		if err != nil {
			log.Printf("Error renaming tag: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to rename tag", "RENAME_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			EventsUpdated int64 `json:"eventsUpdated"`
			Merged        bool  `json:"merged"`
		}{EventsUpdated: result.EventsUpdated, Merged: result.Merged})
	}
}

// removeTagGlobally 复刻 src/lib/tags/db.ts 的 removeTagGlobally：
// 一个事务里读出带该 tag 的事件 → 逐个改写内容 → 删关联行，返回「带该 tag 的
// 事件数」（不是被改写的事件数：内容里可能已经不含该 tag 文本）。
func removeTagGlobally(ctx context.Context, q *db.Queries, tagName string) (int64, error) {
	var removed int64
	err := q.InTx(ctx, func(tx *db.Queries) error {
		// route.ts 先看关联表里有没有行：没有就直接返回 0（连内容都不扫）。
		affected, err := tx.CountEventTagsByTagName(ctx, tagName)
		if err != nil {
			return err
		}
		if affected == 0 {
			return nil
		}

		events, err := tx.ListEventsByTagName(ctx, tagName)
		if err != nil {
			return err
		}
		for _, event := range events {
			updated := RemoveTagFromContent(event.Content, tagName)
			if updated == event.Content {
				continue
			}
			if err := tx.UpdateRawEventContent(ctx, db.UpdateRawEventContentParams{
				Content: updated,
				ID:      event.ID,
			}); err != nil {
				return err
			}
		}

		if err := tx.DeleteEventTagsByTagName(ctx, tagName); err != nil {
			return err
		}
		// removed 是「带该 tag 的事件数」，不是被改写的事件数。
		removed = int64(len(events))
		return nil
	})
	if err != nil {
		return 0, err
	}
	return removed, nil
}

// renameResult 是 {eventsUpdated, merged} 的服务端形状。
type renameResult struct {
	EventsUpdated int64
	Merged        bool
}

// renameTagGlobally 复刻 src/lib/tags/db.ts 的 renameTagGlobally：
//
//   - merged 指「有事件本来就带着新名字」，那些事件上的旧行是删而不是改；
//   - eventsUpdated 是「原来带旧名字的事件数」；
//   - 内容改写对所有原来带旧名字的事件都做（renameTagInContent 的词边界替换）。
//
// 关联表的两次写（删重叠行、改其余行）与 drizzle 版本的分支等价，但不需要把
// id 列表用 IN (…) 拼回 SQL：DeleteOverlappingEventTags / RenameEventTags 用
// 子查询表达同一语义。
func renameTagGlobally(ctx context.Context, q *db.Queries, oldName, newName string) (renameResult, error) {
	var result renameResult
	err := q.InTx(ctx, func(tx *db.Queries) error {
		oldCount, err := tx.CountEventTagsByTagName(ctx, oldName)
		if err != nil {
			return err
		}
		if oldCount == 0 {
			return nil
		}

		// 先读内容再改关联表：ListEventsByTagName 的谓词是「event_tags 里有旧名字」，
		// 顺序反了就查不到行。倒过来做与 drizzle 版本（先取 id 列表、改完再按 id 查）
		// 的结果相同，因为事务内没有别的写者。
		events, err := tx.ListEventsByTagName(ctx, oldName)
		if err != nil {
			return err
		}
		overlap, err := tx.CountOverlappingEventTags(ctx, db.CountOverlappingEventTagsParams{
			OldName: oldName,
			NewName: newName,
		})
		if err != nil {
			return err
		}

		if overlap > 0 {
			if err := tx.DeleteOverlappingEventTags(ctx, db.DeleteOverlappingEventTagsParams{
				OldName: oldName,
				NewName: newName,
			}); err != nil {
				return err
			}
		}
		// 删掉重叠行后，剩下的旧名行就是 drizzle 的 renameIds。
		if err := tx.RenameEventTags(ctx, db.RenameEventTagsParams{
			OldName: oldName,
			NewName: newName,
		}); err != nil {
			return err
		}

		for _, event := range events {
			updated := RenameTagInContent(event.Content, oldName, newName)
			if updated == event.Content {
				continue
			}
			if err := tx.UpdateRawEventContent(ctx, db.UpdateRawEventContentParams{
				Content: updated,
				ID:      event.ID,
			}); err != nil {
				return err
			}
		}

		// merged 只表示「重叠集合非空」——即目标 tag 已经存在于某些事件上。
		result = renameResult{EventsUpdated: int64(len(events)), Merged: overlap > 0}
		return nil
	})
	if err != nil {
		return renameResult{}, err
	}
	return result, nil
}

// IsValidTagName 复刻 src/lib/tags/parse.ts 的 TAG_CHARSET_REGEX：
//
//	^(?=[\p{Script=Han}A-Za-z0-9]*[\p{Script=Han}A-Za-z])[\p{Script=Han}A-Za-z0-9]+$
//
// 即「汉字/字母/数字组成，且至少含一个汉字或字母」——纯数字不接受。
func IsValidTagName(s string) bool {
	if s == "" {
		return false
	}
	hasLetter := false
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', isHan(r):
			hasLetter = true
		case r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return hasLetter
}

// isHan 判定 Script=Han（与 JS 的 \p{Script=Han} 对齐）：Go 的 unicode.Han
// 就是 Unicode Scripts 里的 Han 表，直接复用，避免手抄区段。
func isHan(r rune) bool { return unicode.Is(unicode.Han, r) }
