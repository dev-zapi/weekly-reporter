// Package references 把只读反查路由（`GET /api/events/{id}/references`）挂到 chi
// 的 /api 子路由上。行为逐条对照 src/app/api/events/[id]/references/route.ts。
package references

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把本域注册到 /api 子路由上。
//
// "/events/{id}/references" 与同批的 "/events/{id}" 不冲突：chi 按段数匹配，
// 三段路径只会落到这里。
func Mount(r chi.Router, deps Deps) {
	r.Get("/events/{id}/references", getHandler(deps))
}

// excerptLength 是 src/lib/plan-item-comments/db.ts 的
// COMMENT_REFERRER_EXCERPT_LENGTH：超长评论截到 80 字再加省略号。
const excerptLength = 80

// referrer 是引用方事件的最小投影。eventTime 是 drizzle 的 Date，经
// NextResponse.json（JSON.stringify）序列化为 ISO 8601 UTC 毫秒串。
type referrer struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	EventTime string `json:"eventTime"`
}

// commentReferrer 是计划条目评论侧的引用方，字段即 CommentReferrer 的
// JSON 形状（createdAt 同样是 Date → ISO 串）。
type commentReferrer struct {
	CommentID   int64   `json:"commentId"`
	PlanItemID  int64   `json:"planItemId"`
	Excerpt     string  `json:"excerpt"`
	Author      *string `json:"author"`
	CreatedAt   string  `json:"createdAt"`
	Scope       string  `json:"scope"`
	PeriodStart string  `json:"periodStart"`
	PeriodEnd   string  `json:"periodEnd"`
	MonthKey    *string `json:"monthKey"`
}

// getHandler 复刻 route.ts：
//   - 路径 id 走 parseInt：NaN → 400 {error:'Invalid event ID'}（无 code）；
//   - 目标事件不存在 → 404 {error:'Event not found'}（无 code），即使没人引用它；
//   - 事件侧引用与评论侧引用是两条独立内容面，分开返回；评论侧带
//     {count, comments} 包装；
//   - 空集合都是 [] 而不是 null；
//   - 500 走 {error, code:'FETCH_REFERRERS_ERROR'}。
func getHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := jsparse.ParseInt(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid event ID"})
			return
		}

		ctx := r.Context()

		// 存在性检查先于反查：事件存在但没人引用是 200 + 两个空集合，不是 404。
		exists, err := deps.Queries.RawEventExists(ctx, id)
		if err != nil {
			log.Printf("Error fetching event referrers: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch referrers", "FETCH_REFERRERS_ERROR")
			return
		}
		if !exists {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Event not found"})
			return
		}

		rows, err := deps.Queries.ListEventReferrers(ctx, id)
		if err != nil {
			log.Printf("Error fetching event referrers: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch referrers", "FETCH_REFERRERS_ERROR")
			return
		}
		commentRows, err := deps.Queries.ListCommentReferrers(ctx, id)
		if err != nil {
			log.Printf("Error fetching event referrers: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch referrers", "FETCH_REFERRERS_ERROR")
			return
		}

		referrers := make([]referrer, 0, len(rows))
		for _, row := range rows {
			referrers = append(referrers, referrer{
				ID:        row.ID,
				Content:   row.Content,
				EventTime: isoMillis(row.EventTime),
			})
		}

		comments := make([]commentReferrer, 0, len(commentRows))
		for _, row := range commentRows {
			comments = append(comments, commentReferrer{
				CommentID:   row.CommentID,
				PlanItemID:  row.PlanItemID,
				Excerpt:     toExcerpt(row.Content),
				Author:      row.Author,
				CreatedAt:   isoMillis(row.CreatedAt),
				Scope:       row.Scope,
				PeriodStart: row.PeriodStart,
				PeriodEnd:   row.PeriodEnd,
				MonthKey:    row.MonthKey,
			})
		}

		respond.JSON(w, http.StatusOK, struct {
			Referrers        []referrer `json:"referrers"`
			CommentReferrers struct {
				Count    int               `json:"count"`
				Comments []commentReferrer `json:"comments"`
			} `json:"commentReferrers"`
		}{
			Referrers: referrers,
			CommentReferrers: struct {
				Count    int               `json:"count"`
				Comments []commentReferrer `json:"comments"`
			}{Count: len(comments), Comments: comments},
		})
	}
}

// toExcerpt 复刻 src/lib/plan-item-comments/db.ts 的 toExcerpt：
// `content.replace(/\s+/g, ' ').trim()`，超过 80 字截断并补省略号。
//
// 空白按 ECMAScript 的定义判（不是 Go 的 unicode.IsSpace）：JS 的 \s 与 trim()
// 都认 WhiteSpace + LineTerminator，其中 U+FEFF 在 Go 里不算空白，而 U+0085
// 在 JS 的 \s 里也不算。长度按 UTF-16 码元算，与 slice(0, 80) 的切点一致。
func toExcerpt(content string) string {
	normalized := collapseWhitespace(content)
	if utf16Len(normalized) > excerptLength {
		return truncateUTF16(normalized, excerptLength) + "…"
	}
	return normalized
}

// collapseWhitespace 复刻 replace(/\s+/g, ' ') 之后再 trim()：
// 连续空白折叠成一个空格，首尾空白整段丢弃。
func collapseWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))

	pendingSpace := false
	for _, r := range s {
		if isJSSpace(r) {
			// 只有在已经写出内容之后才记一个待补空格：前缀空白等价于被 trim 掉，
			// 尾随的待补空格在循环结束时自然丢弃（trim 的右端）。
			if b.Len() > 0 {
				pendingSpace = true
			}
			continue
		}
		if pendingSpace {
			b.WriteByte(' ')
			pendingSpace = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// isJSSpace 覆盖 ECMAScript 的 WhiteSpace + LineTerminator 集合。
// 这里按码点写而不是字面字符：集合里有若干不可见字符，字面量无法审阅。
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	// U+2000..U+200A 是连续的一段（en/em quad、各种空格、hair space）。
	return r >= 0x2000 && r <= 0x200A
}

// utf16Len 数 JS 字符串长度（UTF-16 码元数，不是 rune 数）。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16RuneLen(r)
	}
	return n
}

func utf16RuneLen(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}

// truncateUTF16 取前 n 个 UTF-16 码元（JS 的 slice(0, n)）。
// 切点落在代理对中间时，JS 会留下孤立的高位代理；Go 字符串无法表示孤立代理，
// 这里按同一位置切断（丢掉配不成对的那一半），结果是最短可往返的近似。
func truncateUTF16(s string, n int) string {
	count := 0
	for i, r := range s {
		width := utf16RuneLen(r)
		if count+width > n {
			return s[:i]
		}
		count += width
	}
	return s
}

// isoMillis 复刻 JSON.stringify(new Date(ms)) 的输出（toISOString）：
// UTC、毫秒三位、Z 结尾。drizzle 的 timestamp 映射是 Date(秒 * 1e3)。
func isoMillis(unixSeconds int64) string {
	return time.Unix(unixSeconds, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}
