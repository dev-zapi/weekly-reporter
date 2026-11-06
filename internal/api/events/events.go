// Package events 把事件域路由（`/api/events`、`/api/events/{id}`）挂到 chi 的
// /api 子路由上。行为逐条对照 src/app/api/events 下的 route.ts，服务端逻辑移植自
// src/lib/{tags,references,plan-references}（ADR-0012 / ADR-0016 双存储）。
package events

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把事件域注册到 /api 子路由上。
//
// 路由表与 src/app/api/events 目录一一对应：
//
//	GET    /events
//	POST   /events
//	GET    /events/{id}
//	PUT    /events/{id}
//	DELETE /events/{id}
//
// heatmap 与 references 两条更重的查询由同批的另一张票负责，注册在同名前缀下：
// chi 的静态段优先于 {id}，两条路由互不遮蔽。
func Mount(r chi.Router, deps Deps) {
	r.Get("/events", listHandler(deps))
	r.Post("/events", createHandler(deps))
	r.Get("/events/{id}", getHandler(deps))
	r.Put("/events/{id}", updateHandler(deps))
	r.Delete("/events/{id}", deleteHandler(deps))
}

// eventJSON 是 raw_events 行的响应形状：键名与 drizzle 的属性名一致（camelCase），
// 时间列是 Date 经 JSON.stringify 得到的 ISO 字符串，is_important 是 boolean。
type eventJSON struct {
	ID          int64           `json:"id"`
	EventTime   string          `json:"eventTime"`
	Source      string          `json:"source"`
	Content     string          `json:"content"`
	Metadata    json.RawMessage `json:"metadata"`
	Category    *string         `json:"category"`
	IsImportant *bool           `json:"isImportant"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

// isoFromUnix 复刻 `Date.toISOString()`：UTC、毫秒三位、Z 后缀。
// 数据库存 Unix 秒，所以毫秒位恒为 .000。
func isoFromUnix(sec int64) string {
	return time.Unix(sec, 0).UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

// nullMetadata 是响应里 metadata 为 null 时的字面量。
var nullMetadata = json.RawMessage("null")

// metadataFromColumn 把库里的 JSON 文本还原成 JS 侧的值。
//
// drizzle 的 json mode 是 JSON.parse + JSON.stringify，所以：NULL → null；
// 合法 JSON 会按 stringify 的紧凑形式重写；非法 JSON 会让整条查询抛错（route.ts
// 的 catch → 500）。这里用 json.Compact 同时做校验与紧凑化。
func metadataFromColumn(raw []byte) (json.RawMessage, error) {
	if len(raw) == 0 {
		return nullMetadata, nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err
	}
	return json.RawMessage(compact.Bytes()), nil
}

func boolFromColumn(v *int64) *bool {
	if v == nil {
		return nil
	}
	b := *v == 1
	return &b
}

// listHandler 复刻 GET /api/events。
//
// 逐字移植的语义（B1 先例：route.ts 是唯一事实源）：
//   - limit = Math.min(parseInt(limit || '50'), 200)，没有下界；
//   - 非数字 limit 让 drizzle 丢掉 LIMIT 子句，随后 JS 的 slice(0, NaN) 得到空页，
//     hasMore 因为 NaN 比较恒为 false；
//   - 只有 cursorId 与 cursorTime 都非 null 时才加游标条件；
//   - 有 tags 过滤时跳过期/日过滤（全量语义），tag 之间是 OR；
//   - source=manual 精确匹配，source=auto 是 `!= 'manual'`；
//   - 返回 {events, nextCursor, hasMore}，并把 source 别名并进 metadata。
func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()

		limit, limitOK := parseLimit(query.Get("limit"))
		filterTags := parseFilterTags(query.Get("tags"))

		// 六个 flag 是 sqlc 的 interface{}（`?N = 0` 的命名参数）。必须显式给
		// int64(0) 而不是留 nil：NULL = 0 在 SQLite 里是 NULL（假），整条 WHERE 会失效。
		params := db.ListEventsParams{
			WeekFilter:     int64(0),
			WeekStart:      0,
			WeekEnd:        0,
			DateFilter:     int64(0),
			DateStart:      0,
			DateEnd:        0,
			SourceEqFilter: int64(0),
			SourceEq:       "",
			SourceNeFilter: int64(0),
			SourceNe:       "",
			CursorFilter:   int64(0),
			CursorTimeLt:   0,
			CursorTimeEq:   0,
			CursorIDFilter: int64(0),
			CursorID:       0,
			Limit:          0,
		}
		tagParams := db.EventsByTagsParams{Tags: filterTags}

		// 日期 / 周过滤只在没有 tag 过滤时生效（route.ts 的全量语义）。
		if len(filterTags) == 0 {
			weekStart := query.Get("weekStart")
			weekEnd := query.Get("weekEnd")
			if weekStart != "" && weekEnd != "" {
				start := jsdate.ParseString(weekStart)
				end := jsdate.ParseString(weekEnd)
				if !start.Valid || !end.Valid {
					// `between(NaN, …)` 在 SQLite 里恒为假：直接回空页，
					// 不去执行那条必然查不到行的语句。
					writeEventsPage(w, nil, limit, limitOK)
					return
				}
				params.WeekFilter = int64(1)
				params.WeekStart = floorDivSec(start.Millis)
				params.WeekEnd = floorDivSec(endOfLocalDay(end.Millis))
			}

			dateParam := query.Get("date")
			dateObj := jsdate.ParseString(dateParam + "T00:00:00")
			if dateObj.Valid {
				params.DateFilter = int64(1)
				params.DateStart = floorDivSec(dateObj.Millis)
				params.DateEnd = floorDivSec(endOfLocalDay(dateObj.Millis))
			}
		}

		var sourceEqFilter, sourceNeFilter int64
		switch query.Get("source") {
		case "manual":
			sourceEqFilter = 1
			params.SourceEqFilter = int64(1)
			params.SourceEq = "manual"
		case "auto":
			sourceNeFilter = 1
			params.SourceNeFilter = int64(1)
			params.SourceNe = "manual"
		}

		var cursorFilter, cursorIDFilter int64

		// 游标：`cursorId !== null && cursorTime !== null`。空串是 falsy → null；
		// 非数字 → NaN（不是 null），条件照加，只是比较恒为假。
		cursorIDRaw := query.Get("cursorId")
		cursorTimeRaw := query.Get("cursorTime")
		if cursorIDRaw != "" && cursorTimeRaw != "" {
			cursorID, cursorIDOK, _ := jsparse.ParseIntWithOverflow(cursorIDRaw)
			cursorTime, cursorTimeOK, _ := jsparse.ParseIntWithOverflow(cursorTimeRaw)
			if !cursorTimeOK {
				// `event_time < NaN` 与 `event_time = NaN` 恒为假。
				writeEventsPage(w, nil, limit, limitOK)
				return
			}
			cursorFilter = 1
			params.CursorFilter = int64(1)
			// JS 侧是 Math.floor(cursorTime / 1000)，cursorTime 是毫秒。
			cursorSec := floorDivSec(cursorTime)
			params.CursorTimeLt = cursorSec
			params.CursorTimeEq = cursorSec
			if cursorIDOK {
				cursorIDFilter = 1
				params.CursorIDFilter = int64(1)
				params.CursorID = cursorID
			}
		}

		params.Limit = queryLimit(limit, limitOK)

		tagParams.SourceEqFilter = sourceEqFilter
		tagParams.SourceEq = params.SourceEq
		tagParams.SourceNeFilter = sourceNeFilter
		tagParams.SourceNe = params.SourceNe
		tagParams.CursorFilter = cursorFilter
		tagParams.CursorTimeLt = params.CursorTimeLt
		tagParams.CursorTimeEq = params.CursorTimeEq
		tagParams.CursorIDFilter = cursorIDFilter
		tagParams.CursorID = params.CursorID
		tagParams.Limit = params.Limit

		ctx := r.Context()
		var rows []db.ListEventsRow
		var err error
		if len(filterTags) > 0 {
			rows, err = deps.Queries.ListEventsByTags(ctx, tagParams)
		} else {
			rows, err = deps.Queries.ListEvents(ctx, params)
		}
		if err != nil {
			log.Printf("Error fetching events: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch events", "FETCH_ERROR")
			return
		}

		aliases, err := sourceAliases(ctx, deps.Queries)
		if err != nil {
			// route.ts 在同一个 try 里读 collect_sources，失败同样落到 FETCH_ERROR。
			log.Printf("Error fetching events: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch events", "FETCH_ERROR")
			return
		}

		events := make([]listEventJSON, 0, len(rows))
		for _, row := range rows {
			item, err := toListEventJSON(row, aliases)
			if err != nil {
				log.Printf("Error fetching events: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to fetch events", "FETCH_ERROR")
				return
			}
			events = append(events, item)
		}
		writeEventsPage(w, events, limit, limitOK)
	}
}

// listEventJSON 在 eventJSON 之上多带 commentReferrerCount（评论引用数）。
type listEventJSON struct {
	eventJSON
	CommentReferrerCount int64 `json:"commentReferrerCount"`
	// unixEventTime 是 nextCursor 用的秒级原始值（响应里 eventTime 是 ISO 字符串）。
	unixEventTime int64
}

// MarshalJSON 保证键顺序与 drizzle 的 select 投影一致，并让内嵌结构体不塌陷。
func (e listEventJSON) MarshalJSON() ([]byte, error) {
	type raw struct {
		ID                   int64           `json:"id"`
		EventTime            string          `json:"eventTime"`
		Source               string          `json:"source"`
		Content              string          `json:"content"`
		Metadata             json.RawMessage `json:"metadata"`
		Category             *string         `json:"category"`
		IsImportant          *bool           `json:"isImportant"`
		CreatedAt            string          `json:"createdAt"`
		UpdatedAt            string          `json:"updatedAt"`
		CommentReferrerCount int64           `json:"commentReferrerCount"`
	}
	return json.Marshal(raw{
		ID:                   e.ID,
		EventTime:            e.EventTime,
		Source:               e.Source,
		Content:              e.Content,
		Metadata:             e.Metadata,
		Category:             e.Category,
		IsImportant:          e.IsImportant,
		CreatedAt:            e.CreatedAt,
		UpdatedAt:            e.UpdatedAt,
		CommentReferrerCount: e.CommentReferrerCount,
	})
}

func toListEventJSON(row db.ListEventsRow, aliases map[int64]json.RawMessage) (listEventJSON, error) {
	base := eventJSON{
		ID:          row.ID,
		EventTime:   isoFromUnix(row.EventTime),
		Source:      row.Source,
		Content:     row.Content,
		Category:    row.Category,
		IsImportant: boolFromColumn(row.IsImportant),
		CreatedAt:   isoFromUnix(row.CreatedAt),
		UpdatedAt:   isoFromUnix(row.UpdatedAt),
	}
	metadata, err := metadataFromColumn(row.Metadata)
	if err != nil {
		return listEventJSON{eventJSON: base, CommentReferrerCount: row.CommentReferrerCount, unixEventTime: row.EventTime}, err
	}
	base.Metadata = mergeAliases(metadata, aliases)
	return listEventJSON{
		eventJSON:            base,
		CommentReferrerCount: row.CommentReferrerCount,
		unixEventTime:        row.EventTime,
	}, nil
}

// mergeAliases 复刻 `{...event.metadata, aliases}`：metadata 为 null 时摊平成 {}，
// aliases 由 metadata.sourceId 决定（查不到就是空数组）。
func mergeAliases(metadata json.RawMessage, aliases map[int64]json.RawMessage) json.RawMessage {
	fields := map[string]json.RawMessage{}
	if isJSONObject(metadata) {
		if err := json.Unmarshal(metadata, &fields); err != nil {
			fields = map[string]json.RawMessage{}
		}
	}

	var list json.RawMessage = json.RawMessage("[]")
	if rawSourceID, ok := fields["sourceId"]; ok {
		// `sourceId ? map.get(sourceId) || [] : []`：0 是假值，直接走空数组。
		var sourceID int64
		if err := json.Unmarshal(rawSourceID, &sourceID); err == nil && sourceID != 0 {
			if found, ok := aliases[sourceID]; ok {
				list = found
			}
		}
	}
	fields["aliases"] = list

	encoded, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

// sourceAliases 读全部 collect_sources 的别名，key 是 source id。
//
// config 是 JSON 文本列（drizzle 的 json mode），`config.aliases || []` 的语义：
// 缺失 / null → 空数组，其它值原样透传（与 TS 的 `as string[] || []` 一致）。
// 非法 JSON 时 drizzle 的 mapFromDriverValue 抛错、整条请求落进 catch，这里一样返回错误。
func sourceAliases(ctx context.Context, q *db.Queries) (map[int64]json.RawMessage, error) {
	rows, err := q.ListCollectSourcesForAliases(ctx)
	if err != nil {
		return nil, err
	}

	aliases := make(map[int64]json.RawMessage, len(rows))
	for _, row := range rows {
		var config map[string]json.RawMessage
		if len(row.Config) > 0 {
			if err := json.Unmarshal(row.Config, &config); err != nil {
				return nil, err
			}
		}
		if raw, ok := config["aliases"]; ok && !isJSONNull(raw) {
			aliases[row.ID] = raw
		} else {
			aliases[row.ID] = json.RawMessage("[]")
		}
	}
	return aliases, nil
}

func isJSONNull(raw json.RawMessage) bool {
	return string(raw) == "null"
}

// eventsPage 是 GET 的响应体。
type eventsPage struct {
	Events     []listEventJSON `json:"events"`
	NextCursor *struct {
		ID        int64 `json:"id"`
		EventTime int64 `json:"eventTime"`
	} `json:"nextCursor"`
	HasMore bool `json:"hasMore"`
}

// writeEventsPage 复刻 GET 尾部的分页计算：
//
//	hasMore = events.length > limit          （NaN limit → false）
//	page    = events.slice(0, limit)         （NaN → 空；负数从尾部扣；越界取全长）
//	nextCursor = page.at(-1) ? {id, eventTime 毫秒} : null
func writeEventsPage(w http.ResponseWriter, events []listEventJSON, limit int64, limitOK bool) {
	hasMore := false
	var page []listEventJSON
	if limitOK {
		hasMore = int64(len(events)) > limit
		page = sliceJS(events, limit)
	} else {
		// limit 是 NaN：slice(0, NaN) 得到空数组，`n > NaN` 恒为 false。
		page = []listEventJSON{}
	}
	if page == nil {
		page = []listEventJSON{}
	}

	resp := eventsPage{Events: page, HasMore: hasMore}
	if len(page) > 0 {
		last := page[len(page)-1]
		cursor := struct {
			ID        int64 `json:"id"`
			EventTime int64 `json:"eventTime"`
		}{ID: last.ID, EventTime: last.unixEventTime * 1000}
		resp.NextCursor = &cursor
	}
	respond.JSON(w, http.StatusOK, resp)
}

// sliceJS 复刻 `array.slice(0, end)` 的边界规则：NaN → 0、负数 → len+end（不小于 0）、
// 超过长度 → 长度。
func sliceJS(events []listEventJSON, end int64) []listEventJSON {
	n := int64(len(events))
	if end < 0 {
		end = n + end
		if end < 0 {
			end = 0
		}
	}
	if end > n {
		end = n
	}
	return events[:end]
}

// parseLimit 复刻 `Math.min(parseInt(sp.get('limit') || '50'), 200)`。
// ok=false 表示 parseInt 得到 NaN。空串走默认值（`||` 把空串当假值）。
func parseLimit(raw string) (int64, bool) {
	if raw == "" {
		return 50, true
	}
	n, ok := jsparse.ParseInt(raw)
	if !ok {
		return 0, false
	}
	if n > 200 {
		n = 200
	}
	return n, true
}

// queryLimit 把 JS 的 limit 折成 SQL 的 LIMIT 值。
//
// route.ts 查的是 `limit + 1` 行，然后 slice 掉多余的那行来判 hasMore；drizzle 的
// buildLimit 只在 `limit >= 0` 时才拼子句，所以 limit+1 为负（limit ≤ -2）时整条
// LIMIT 消失。NaN 同理（limitOK=false → 整条 LIMIT 消失）。
func queryLimit(limit int64, limitOK bool) int64 {
	if !limitOK {
		return -1
	}
	next := limit + 1
	if next < 0 {
		return -1
	}
	return next
}

// parseFilterTags 复刻
// `tags.split(',').map(t => t.trim()).filter(t => TAG_CHARSET_REGEX.test(t))`。
func parseFilterTags(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := splitComma(raw)
	tags := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := jsstr.Trim(part)
		if isTagName(trimmed) {
			tags = append(tags, trimmed)
		}
	}
	return tags
}

func splitComma(s string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	return append(parts, s[start:])
}

// endOfLocalDay 复刻 `d.setHours(23, 59, 59, 999)`：把毫秒时刻折成「本地时区当天
// 的最后一毫秒」。
func endOfLocalDay(ms int64) int64 {
	lt := time.UnixMilli(ms).In(time.Local)
	end := time.Date(lt.Year(), lt.Month(), lt.Day(), 23, 59, 59, 999*int(time.Millisecond), time.Local)
	return end.UnixMilli()
}

// floorDivSec 复刻 `Math.floor(ms / 1000)`（drizzle 的 timestamp 映射与游标换算都用它）：
// 负数向 -∞ 取整，与 Go 的整数除法（向零截断）不同。
func floorDivSec(ms int64) int64 {
	return int64(math.Floor(float64(ms) / 1000))
}

// getHandler 复刻 GET /api/events/{id}：行 + tags 数组（无 tag 时是 []）。
func getHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := jsparse.ParseInt(chi.URLParam(r, "id"))
		if !ok {
			// route.ts 这条分支只回 {error}，没有 code。
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid event ID"})
			return
		}

		row, err := deps.Queries.GetRawEvent(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Event not found"})
			return
		}
		if err != nil {
			log.Printf("Error fetching event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch event", "FETCH_ERROR")
			return
		}

		tags, err := deps.Queries.ListEventTagNames(r.Context(), id)
		if err != nil {
			log.Printf("Error fetching event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch event", "FETCH_ERROR")
			return
		}
		metadata, err := metadataFromColumn(row.Metadata)
		if err != nil {
			log.Printf("Error fetching event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch event", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			ID          int64           `json:"id"`
			EventTime   string          `json:"eventTime"`
			Source      string          `json:"source"`
			Content     string          `json:"content"`
			Metadata    json.RawMessage `json:"metadata"`
			Category    *string         `json:"category"`
			IsImportant *bool           `json:"isImportant"`
			CreatedAt   string          `json:"createdAt"`
			UpdatedAt   string          `json:"updatedAt"`
			Tags        []string        `json:"tags"`
		}{
			ID:          row.ID,
			EventTime:   isoFromUnix(row.EventTime),
			Source:      row.Source,
			Content:     row.Content,
			Metadata:    metadata,
			Category:    row.Category,
			IsImportant: boolFromColumn(row.IsImportant),
			CreatedAt:   isoFromUnix(row.CreatedAt),
			UpdatedAt:   isoFromUnix(row.UpdatedAt),
			Tags:        append([]string{}, tags...),
		})
	}
}

// createHandler 复刻 POST /api/events：内容必填非空白，eventTime 可选；
// 在同一事务里写事件并同步 tags / @引用 / %计划引用。
func createHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rawBody, err := decodeJSON(r)
		if err != nil || rawBody == nil {
			// `const { content, eventTime } = body` 对 null 抛错 → catch。
			log.Printf("Error creating event: unusable request body: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create event", "CREATE_ERROR")
			return
		}
		// 数组/字符串/数字在 JS 里也能解构（字段全是 undefined），统一折成空字段视图。
		body, _ := objectBody(rawBody)

		content, _ := body["content"].(string)
		if content == "" || jsstr.Trim(content) == "" {
			respond.Error(w, http.StatusBadRequest, "Content is required", "INVALID_CONTENT")
			return
		}

		// route.ts 只取一次 `const now = new Date()`：eventTime 缺省、createdAt、
		// updatedAt 都用同一个时刻，所以这里也只取一次。
		nowMillis := time.Now().UnixMilli()
		eventTimeMillis := nowMillis
		if rawEventTime, hasEventTime := body["eventTime"]; hasEventTime && rawEventTime != nil {
			parsed, ok := coerceDate(rawEventTime)
			if !ok {
				respond.Error(w, http.StatusBadRequest, "Invalid event time", "INVALID_EVENT_TIME")
				return
			}
			// `eventTime ? new Date(eventTime) : now`：校验通过后仍按真值判断，
			// 0 / "" / false 这类假值退回当前时间。
			if truthyJSON(rawEventTime) {
				eventTimeMillis = parsed.Millis
			}
		}

		nowSec := floorDivSec(nowMillis)
		var created db.InsertManualRawEventRow
		err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
			row, err := tx.InsertManualRawEvent(r.Context(), db.InsertManualRawEventParams{
				EventTime: floorDivSec(eventTimeMillis),
				Content:   content,
				CreatedAt: nowSec,
				UpdatedAt: nowSec,
			})
			if err != nil {
				return err
			}
			created = row

			if err := syncEventTags(r.Context(), tx, row.ID, parseTags(content)); err != nil {
				return err
			}
			if err := syncEventReferences(r.Context(), tx, row.ID, ParseReferences(content)); err != nil {
				return err
			}
			return syncEventPlanReferences(r.Context(), tx, row.ID, ParsePlanReferences(content))
		})
		if err != nil {
			log.Printf("Error creating event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create event", "CREATE_ERROR")
			return
		}

		metadata, err := metadataFromColumn(created.Metadata)
		if err != nil {
			log.Printf("Error creating event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create event", "CREATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusCreated, eventJSON{
			ID:          created.ID,
			EventTime:   isoFromUnix(created.EventTime),
			Source:      created.Source,
			Content:     created.Content,
			Metadata:    metadata,
			Category:    created.Category,
			IsImportant: boolFromColumn(created.IsImportant),
			CreatedAt:   isoFromUnix(created.CreatedAt),
			UpdatedAt:   isoFromUnix(created.UpdatedAt),
		})
	}
}

// updateHandler 复刻 PUT /api/events/{id}。
//
// 逐字移植的判定顺序：存在性 → JSON 解析 → `!body || typeof body !== 'object'`
// → content → eventTime → isImportant。注意 JSON `null` 命中第三条（返回 400
// EMPTY_BODY），而数组能穿过它（数组是 object 且 truthy），最终变成一次「只刷新
// updatedAt」的更新。
func updateHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := jsparse.ParseInt(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid event ID"})
			return
		}

		existing, err := deps.Queries.GetRawEvent(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Event not found"})
			return
		}
		if err != nil {
			log.Printf("Error updating event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update event", "UPDATE_ERROR")
			return
		}

		rawBody, err := decodeJSON(r)
		if err != nil {
			respond.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_BODY")
			return
		}
		if rawBody == nil {
			// `!body` 对 JSON null 为真（typeof null === 'object'，所以命中这一条）。
			respond.Error(w, http.StatusBadRequest, "Request body cannot be empty", "EMPTY_BODY")
			return
		}
		body, isObject := objectBody(rawBody)
		if !isObject {
			// typeof 不是 object：字符串 / 数字 / 布尔同样命中 EMPTY_BODY。
			respond.Error(w, http.StatusBadRequest, "Request body cannot be empty", "EMPTY_BODY")
			return
		}

		params := db.UpdateRawEventParams{
			Content:     nil,
			EventTime:   nil,
			IsImportant: nil,
			UpdatedAt:   time.Now().Unix(),
			ID:          id,
		}

		contentProvided := false
		contentValue := ""
		if rawContent, present := body["content"]; present {
			content, isString := rawContent.(string)
			if !isString || jsstr.Trim(content) == "" {
				respond.Error(w, http.StatusBadRequest, "Content is required", "INVALID_CONTENT")
				return
			}
			contentProvided = true
			contentValue = content
			params.Content = &contentValue
		}

		if rawEventTime, present := body["eventTime"]; present {
			parsed, ok := coerceDate(rawEventTime)
			if !ok {
				respond.Error(w, http.StatusBadRequest, "Invalid event time", "INVALID_EVENT_TIME")
				return
			}
			sec := floorDivSec(parsed.Millis)
			params.EventTime = &sec
		}

		if rawImportant, present := body["isImportant"]; present {
			important, isBool := rawImportant.(bool)
			if !isBool {
				respond.Error(w, http.StatusBadRequest, "isImportant must be a boolean", "INVALID_IS_IMPORTANT")
				return
			}
			flag := int64(0)
			if important {
				flag = 1
			}
			params.IsImportant = &flag
		}

		var updated db.UpdateRawEventRow
		err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
			row, err := tx.UpdateRawEvent(r.Context(), params)
			if err != nil {
				return err
			}
			updated = row

			// 只有「给了 content」且「事件是手动来源」时才重建三张关联表。
			if !contentProvided || existing.Source != "manual" {
				return nil
			}
			if err := syncEventTags(r.Context(), tx, id, parseTags(contentValue)); err != nil {
				return err
			}
			if err := syncEventReferences(r.Context(), tx, id, ParseReferences(contentValue)); err != nil {
				return err
			}
			return syncEventPlanReferences(r.Context(), tx, id, ParsePlanReferences(contentValue))
		})
		if err != nil {
			log.Printf("Error updating event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update event", "UPDATE_ERROR")
			return
		}

		metadata, err := metadataFromColumn(updated.Metadata)
		if err != nil {
			log.Printf("Error updating event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update event", "UPDATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, eventJSON{
			ID:          updated.ID,
			EventTime:   isoFromUnix(updated.EventTime),
			Source:      updated.Source,
			Content:     updated.Content,
			Metadata:    metadata,
			Category:    updated.Category,
			IsImportant: boolFromColumn(updated.IsImportant),
			CreatedAt:   isoFromUnix(updated.CreatedAt),
			UpdatedAt:   isoFromUnix(updated.UpdatedAt),
		})
	}
}

// deleteHandler 复刻 DELETE /api/events/{id}：非手动来源 403；手动来源在一个事务里
// 清掉四张关联表（tags / @引用双向 / %计划引用 / 指向它的评论引用）再删事件，
// 回 204 无 body。
func deleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := jsparse.ParseInt(chi.URLParam(r, "id"))
		if !ok {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{Error: "Invalid event ID"})
			return
		}

		existing, err := deps.Queries.GetRawEvent(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Event not found"})
			return
		}
		if err != nil {
			log.Printf("Error deleting event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete event", "DELETE_ERROR")
			return
		}
		if existing.Source != "manual" {
			respond.JSON(w, http.StatusForbidden, respond.ErrorBody{Error: "Cannot delete non-manual event"})
			return
		}

		err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
			if err := tx.DeleteEventTagsByEventID(r.Context(), id); err != nil {
				return err
			}
			if err := tx.DeleteEventReferencesForEvent(r.Context(), id); err != nil {
				return err
			}
			if err := tx.DeleteEventPlanReferencesByEventID(r.Context(), id); err != nil {
				return err
			}
			// 评论文本保留，只清指向本事件的引用索引行（悬挂引用是设计）。
			if err := tx.DeleteCommentReferencesForEvent(r.Context(), id); err != nil {
				return err
			}
			return tx.DeleteRawEvent(r.Context(), id)
		})
		if err != nil {
			log.Printf("Error deleting event: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete event", "DELETE_ERROR")
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// syncEventTags 复刻 src/lib/tags/db.ts 的 syncEventTags：先删该事件的关联行，
// 再按解析结果重插（空列表直接返回）。
func syncEventTags(ctx context.Context, tx *db.Queries, eventID int64, tagNames []string) error {
	if err := tx.DeleteEventTagsByEventID(ctx, eventID); err != nil {
		return err
	}
	if len(tagNames) == 0 {
		return nil
	}
	now := time.Now().Unix()
	for _, name := range tagNames {
		if err := tx.InsertEventTag(ctx, db.InsertEventTagParams{
			EventID:   eventID,
			TagName:   name,
			CreatedAt: now,
		}); err != nil {
			return err
		}
	}
	return nil
}

// syncEventReferences 复刻 src/lib/references/db.ts 的 syncEventReferences（ADR-0016）。
func syncEventReferences(ctx context.Context, tx *db.Queries, eventID int64, referencedIDs []int64) error {
	if err := tx.DeleteEventReferencesByEventID(ctx, eventID); err != nil {
		return err
	}
	if len(referencedIDs) == 0 {
		return nil
	}
	now := time.Now().Unix()
	for _, referencedID := range referencedIDs {
		if err := tx.InsertEventReference(ctx, db.InsertEventReferenceParams{
			EventID:           eventID,
			ReferencedEventID: referencedID,
			CreatedAt:         now,
		}); err != nil {
			return err
		}
	}
	return nil
}

// syncEventPlanReferences 复刻 src/lib/plan-references/db.ts 的同名函数。
func syncEventPlanReferences(ctx context.Context, tx *db.Queries, eventID int64, planItemIDs []int64) error {
	if err := tx.DeleteEventPlanReferencesByEventID(ctx, eventID); err != nil {
		return err
	}
	if len(planItemIDs) == 0 {
		return nil
	}
	now := time.Now().Unix()
	for _, planItemID := range planItemIDs {
		if err := tx.InsertEventPlanReference(ctx, db.InsertEventPlanReferenceParams{
			EventID:    eventID,
			PlanItemID: planItemID,
			CreatedAt:  now,
		}); err != nil {
			return err
		}
	}
	return nil
}
