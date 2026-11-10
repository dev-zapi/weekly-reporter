package events_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 本文件是 src/app/api/events/route.test.ts 的 Go 同用例集（ADR-0029）：
// GET 7 条 + POST 7 条逐条对应，另外把 route.ts 的 limit / 分页怪癖钉成表驱动用例。
// 断言跑在真实 SQLite 与真实中间件链上（vitest 那边 mock 掉了查询构造器）。

type eventsBodyJSON struct {
	ID                   int64          `json:"id"`
	EventTime            string         `json:"eventTime"`
	Source               string         `json:"source"`
	Content              string         `json:"content"`
	Metadata             map[string]any `json:"metadata"`
	Category             *string        `json:"category"`
	IsImportant          *bool          `json:"isImportant"`
	CreatedAt            string         `json:"createdAt"`
	UpdatedAt            string         `json:"updatedAt"`
	CommentReferrerCount *int64         `json:"commentReferrerCount"`
}

type eventsResponse struct {
	Events     []eventsBodyJSON `json:"events"`
	NextCursor *struct {
		ID        int64 `json:"id"`
		EventTime int64 `json:"eventTime"`
	} `json:"nextCursor"`
	HasMore bool `json:"hasMore"`
}

func decodeEvents(t *testing.T, body []byte) eventsResponse {
	t.Helper()
	var resp eventsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func decodeError(t *testing.T, body []byte) (string, string) {
	t.Helper()
	var resp struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode error body %s: %v", body, err)
	}
	return resp.Error, resp.Code
}

func TestEventsGetReturnsEventsOrderedByEventTimeDesc(t *testing.T) {
	h := newHarness(t)
	laterTime := time.Date(2024, 1, 10, 10, 0, 0, 0, time.UTC)
	earlierTime := time.Date(2024, 1, 8, 10, 0, 0, 0, time.UTC)
	later := h.seedEvent("Later event", "github", laterTime.Unix(), "")
	earlier := h.seedEvent("Earlier event", "manual", earlierTime.Unix(), "")

	rec := h.do(http.MethodGet, "/api/events", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	resp := decodeEvents(t, rec.Body.Bytes())
	if len(resp.Events) != 2 {
		t.Fatalf("events = %d, want 2", len(resp.Events))
	}
	if resp.Events[0].ID != later || resp.Events[1].ID != earlier {
		t.Fatalf("order = [%d %d], want [%d %d]", resp.Events[0].ID, resp.Events[1].ID, later, earlier)
	}
	// 冻结契约：drizzle 把 timestamp 列映射成 Date，JSON 序列化后是 ISO 字符串。
	if resp.Events[0].EventTime != "2024-01-10T10:00:00.000Z" {
		t.Fatalf("eventTime = %q, want ISO string", resp.Events[0].EventTime)
	}
	if resp.Events[0].Source != "github" || resp.Events[0].Content != "Later event" {
		t.Fatalf("event = %+v", resp.Events[0])
	}
	// route.ts 在 page 非空时总是回 nextCursor（与 hasMore 无关）：`last ? {...} : null`。
	if resp.HasMore {
		t.Fatalf("hasMore = true, want false")
	}
	if resp.NextCursor == nil || resp.NextCursor.ID != earlier {
		t.Fatalf("nextCursor = %+v, want the last row", resp.NextCursor)
	}
}

// 周界按请求自带的偏移取整到日历日：weekStart 是起始日零点（含），weekEnd 是
// 结束日零点 + 24h（不含）。期望值用 RFC3339 字面量独立算出，不重复实现取整。
func TestEventsGetFiltersByWeekRangeAtRequestOffset(t *testing.T) {
	h := newHarness(t)
	inRange := h.seedEvent("Event in range", "github", mustUnix(t, "2024-01-08T00:00:00+08:00"), "")
	lastSecond := h.seedEvent("Last second", "github", mustUnix(t, "2024-01-14T23:59:59+08:00"), "")
	tooEarly := h.seedEvent("Too early", "github", mustUnix(t, "2024-01-07T23:59:59+08:00"), "")
	tooLate := h.seedEvent("Too late", "github", mustUnix(t, "2024-01-15T00:00:00+08:00"), "")

	q := url.Values{}
	q.Set("weekStart", "2024-01-08T00:00:00+08:00")
	q.Set("weekEnd", "2024-01-14T00:00:00+08:00")
	rec := h.do(http.MethodGet, "/api/events?"+q.Encode(), "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decodeEvents(t, rec.Body.Bytes())
	if len(resp.Events) != 2 || resp.Events[0].ID != lastSecond || resp.Events[1].ID != inRange {
		t.Fatalf("events = %+v, want only %d and %d (early %d, late %d)",
			resp.Events, lastSecond, inRange, tooEarly, tooLate)
	}
}

// 票内用例：status 参数 route.ts 根本不读，传了也必须被忽略。
func TestEventsGetIgnoresUnknownStatusParam(t *testing.T) {
	h := newHarness(t)
	h.seedEvent("pending event", "github", 1_704_672_000, "")
	h.seedEvent("processed event", "github", 1_704_758_400, "")

	rec := h.do(http.MethodGet, "/api/events?weekStart=2024-01-08T00:00:00Z&weekEnd=2024-01-14T00:00:00Z&status=processed", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if resp := decodeEvents(t, rec.Body.Bytes()); len(resp.Events) != 2 {
		t.Fatalf("events = %d, want both rows (status is not a filter)", len(resp.Events))
	}
}

// date 参数的日历日由请求自带偏移决定：即使入参是当天 15:30，也取整到该偏移的
// 00:00，窗口是 [零点, +24h)。Jan 10 的 +08:00 零点 = Jan 9 16:00Z。
func TestEventsGetFiltersByDateParamAtRequestOffset(t *testing.T) {
	h := newHarness(t)
	onDay := h.seedEvent("On day", "manual", mustUnix(t, "2024-01-10T00:00:00+08:00"), "")
	lastSecond := h.seedEvent("Last second", "manual", mustUnix(t, "2024-01-10T23:59:59+08:00"), "")
	h.seedEvent("Previous day", "manual", mustUnix(t, "2024-01-09T23:59:59+08:00"), "")
	h.seedEvent("Next day", "manual", mustUnix(t, "2024-01-11T00:00:00+08:00"), "")

	rec := h.do(http.MethodGet, "/api/events?date=2024-01-10T15:30:00%2B08:00", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decodeEvents(t, rec.Body.Bytes())
	if len(resp.Events) != 2 || resp.Events[0].ID != lastSecond || resp.Events[1].ID != onDay {
		t.Fatalf("events = %+v, want only %d and %d", resp.Events, lastSecond, onDay)
	}
}

// 同一个绝对时刻在不同请求偏移下落到不同日历日：证明分组跟随请求，而不是服务器
// 本地时区。2024-01-09T17:00Z == 2024-01-10T01:00+08:00 == 2024-01-09T12:00-05:00。
func TestEventsGetDateWindowFollowsRequestOffset(t *testing.T) {
	h := newHarness(t)
	event := h.seedEvent("Around midnight", "manual", mustUnix(t, "2024-01-09T17:00:00Z"), "")

	cases := []struct {
		date   string
		want   bool
		reason string
	}{
		{"2024-01-10T00:00:00+08:00", true, "Shanghai sees Jan 10"},
		{"2024-01-09T00:00:00Z", true, "UTC sees Jan 9"},
		{"2024-01-09T00:00:00-05:00", true, "New York sees Jan 9"},
		{"2024-01-11T00:00:00+08:00", false, "Shanghai Jan 11 is the next day"},
	}
	for _, tc := range cases {
		t.Run(tc.date, func(t *testing.T) {
			q := url.Values{}
			q.Set("date", tc.date)
			rec := h.do(http.MethodGet, "/api/events?"+q.Encode(), "", testPassword)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			resp := decodeEvents(t, rec.Body.Bytes())
			if got := len(resp.Events) == 1 && resp.Events[0].ID == event; got != tc.want {
				t.Fatalf("included = %t, want %t (%s; events %+v)", got, tc.want, tc.reason, resp.Events)
			}
		})
	}
}

func TestEventsGetCombinesDateAndSourceFilters(t *testing.T) {
	h := newHarness(t)
	day := mustUnix(t, "2024-01-10T12:00:00+08:00")
	h.seedEvent("manual on day", "manual", day, "")
	h.seedEvent("github on day", "github", day+60, "")

	rec := h.do(http.MethodGet, "/api/events?date=2024-01-10T00:00:00%2B08:00&source=manual", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeEvents(t, rec.Body.Bytes())
	if len(resp.Events) != 1 || resp.Events[0].Source != "manual" {
		t.Fatalf("events = %+v, want only manual", resp.Events)
	}
}

// date-only 是非法 wire 形态：400 必须在错误信息里给出带偏移的期望示例。
func TestEventsGetRejectsDateOnlyParameters(t *testing.T) {
	h := newHarness(t)
	h.seedEvent("anything", "manual", 1_704_672_000, "")

	cases := []struct {
		query string
		code  string
	}{
		{"date=2024-01-10", "INVALID_DATE"},
		{"weekStart=2024-01-08", "INVALID_WEEK_START"},
		{"weekEnd=2024-01-14", "INVALID_WEEK_END"},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			rec := h.do(http.MethodGet, "/api/events?"+tc.query, "", testPassword)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			msg, code := decodeError(t, rec.Body.Bytes())
			if code != tc.code {
				t.Fatalf("code = %q, want %q", code, tc.code)
			}
			if !strings.Contains(msg, "RFC3339") || !strings.Contains(msg, "2026-11-03T00:00:00+08:00") {
				t.Fatalf("message %q must name RFC3339 and show an offset example", msg)
			}
		})
	}
}

func TestEventsGetReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodGet, "/api/events", "", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	msg, code := decodeError(t, rec.Body.Bytes())
	if msg != "Failed to fetch events" || code != "FETCH_ERROR" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

// route.ts 的 metadata 处理是 `{...event.metadata, aliases}`：null 被摊平成 {}，
// 所以列表响应里 metadata 永远不是 null；sourceId 命中 collect_sources 时附带别名。
func TestEventsGetAppendsAliasesToMetadata(t *testing.T) {
	h := newHarness(t)
	sourceID := h.seedSource(`{"aliases":["alpha","beta"]}`)
	withSource := h.seedEvent("from git", "git-local", 1_704_672_000, `{"repo":"weekly-reporter","sourceId":`+itoa(sourceID)+`}`)
	noMetadata := h.seedEvent("plain manual", "manual", 1_704_758_400, "")
	h.seedEvent("unknown source", "git-local", 1_704_844_800, `{"sourceId":999}`)

	rec := h.do(http.MethodGet, "/api/events", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeEvents(t, rec.Body.Bytes())
	byID := map[int64]eventsBodyJSON{}
	for _, ev := range resp.Events {
		byID[ev.ID] = ev
	}

	got := byID[withSource].Metadata
	if got["repo"] != "weekly-reporter" {
		t.Fatalf("metadata = %+v", got)
	}
	aliases, _ := got["aliases"].([]any)
	if len(aliases) != 2 || aliases[0] != "alpha" {
		t.Fatalf("aliases = %+v", got["aliases"])
	}

	if byID[noMetadata].Metadata == nil {
		t.Fatalf("null metadata must become an object with aliases:[]")
	}
	if aliases, ok := byID[noMetadata].Metadata["aliases"].([]any); !ok || len(aliases) != 0 {
		t.Fatalf("aliases = %+v", byID[noMetadata].Metadata["aliases"])
	}
}

// limit 语义复刻 `Math.min(parseInt(sp.get('limit') || '50'), 200)`：
// 没有下界 clamp；NaN 让 drizzle 丢掉 LIMIT 子句，而 JS 的 slice(0, NaN) 是空数组。
func TestEventsGetLimitQuirksMirrorRouteTS(t *testing.T) {
	cases := []struct {
		name      string
		query     string
		wantCount int
		wantMore  bool
	}{
		{"default", "", 3, false},
		{"limit 2", "?limit=2", 2, true},
		{"limit 0 keeps hasMore", "?limit=0", 0, true},
		{"limit abc yields empty page", "?limit=abc", 0, false},
		// limit=-1 → drizzle 收到 limit(0)，真的拼出 LIMIT 0；hasMore 仍是 0 > -1。
		{"limit -1", "?limit=-1", 0, true},
		// limit=-5 → limit+1 为负，drizzle 丢掉 LIMIT 子句；slice(0,-5) 再去掉尾部。
		{"limit -5", "?limit=-5", 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			for i := 0; i < 3; i++ {
				h.seedEvent("event", "manual", int64(1_700_000_000+i*100), "")
			}
			rec := h.do(http.MethodGet, "/api/events"+tc.query, "", testPassword)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			resp := decodeEvents(t, rec.Body.Bytes())
			if len(resp.Events) != tc.wantCount {
				t.Fatalf("events = %d, want %d (%s)", len(resp.Events), tc.wantCount, rec.Body.String())
			}
			if resp.HasMore != tc.wantMore {
				t.Fatalf("hasMore = %v, want %v", resp.HasMore, tc.wantMore)
			}
		})
	}
}

// 游标分页：(eventTime, id) 复合条件；nextCursor.eventTime 是毫秒。
func TestEventsGetPaginatesWithCursor(t *testing.T) {
	h := newHarness(t)
	newest := h.seedEvent("newest", "manual", 1_700_000_300, "")
	middle := h.seedEvent("middle", "manual", 1_700_000_200, "")
	oldest := h.seedEvent("oldest", "manual", 1_700_000_100, "")

	first := h.do(http.MethodGet, "/api/events?limit=1", "", testPassword)
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d", first.Code)
	}
	page := decodeEvents(t, first.Body.Bytes())
	if len(page.Events) != 1 || page.Events[0].ID != newest || !page.HasMore {
		t.Fatalf("page = %+v", page)
	}
	if page.NextCursor == nil || page.NextCursor.ID != newest || page.NextCursor.EventTime != 1_700_000_300_000 {
		t.Fatalf("nextCursor = %+v", page.NextCursor)
	}

	next := h.do(http.MethodGet,
		"/api/events?limit=2&cursorId="+itoa(page.NextCursor.ID)+"&cursorTime="+itoa(page.NextCursor.EventTime), "", testPassword)
	if next.Code != http.StatusOK {
		t.Fatalf("status = %d", next.Code)
	}
	rest := decodeEvents(t, next.Body.Bytes())
	if len(rest.Events) != 2 || rest.Events[0].ID != middle || rest.Events[1].ID != oldest {
		t.Fatalf("rest = %+v", rest)
	}
}

// 只给 cursorId 或只给 cursorTime 时，route.ts 的条件整体不生效。
func TestEventsGetIgnoresHalfCursor(t *testing.T) {
	h := newHarness(t)
	h.seedEvent("a", "manual", 1_700_000_100, "")
	h.seedEvent("b", "manual", 1_700_000_200, "")

	for _, query := range []string{"?cursorId=1", "?cursorTime=1700000200000"} {
		rec := h.do(http.MethodGet, "/api/events"+query, "", testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d", query, rec.Code)
		}
		if resp := decodeEvents(t, rec.Body.Bytes()); len(resp.Events) != 2 {
			t.Fatalf("%s events = %d, want 2", query, len(resp.Events))
		}
	}
}

// 非法游标：parseInt 得到 NaN，但 NaN 不是 null，所以条件照加、比较恒假 → 空页
// （200，不是 400/500）。cursorId 单独非法时只剩 `event_time < cursorTime` 那半边。
func TestEventsGetNonNumericCursorMirrorsRouteTS(t *testing.T) {
	h := newHarness(t)
	h.seedEvent("a", "manual", 1_700_000_100, "")
	h.seedEvent("b", "manual", 1_700_000_200, "")

	t.Run("cursorTime NaN makes the whole condition false", func(t *testing.T) {
		rec := h.do(http.MethodGet, "/api/events?cursorId=abc&cursorTime=abc", "", testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if resp := decodeEvents(t, rec.Body.Bytes()); len(resp.Events) != 0 {
			t.Fatalf("events = %d, want 0", len(resp.Events))
		}
	})

	t.Run("cursorId NaN keeps the event_time half", func(t *testing.T) {
		// cursorTime=1700000150000 → 1700000150 秒；只有更早的那条满足 <。
		rec := h.do(http.MethodGet, "/api/events?cursorId=abc&cursorTime=1700000150000", "", testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		resp := decodeEvents(t, rec.Body.Bytes())
		if len(resp.Events) != 1 || resp.Events[0].Content != "a" {
			t.Fatalf("events = %+v, want only a", resp.Events)
		}
	})
}

// 非 RFC3339 的周界同样是 400，而不是静默空页。
func TestEventsGetRejectsGarbageWeekRange(t *testing.T) {
	h := newHarness(t)
	h.seedEvent("anything", "manual", 1_704_672_000, "")

	rec := h.do(http.MethodGet, "/api/events?weekStart=garbage&weekEnd=also-garbage", "", testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
}

// 有 tags 时 date/weekStart 被跳过（全量语义），但 source 仍然生效。
func TestEventsGetTagsSkipDateFilters(t *testing.T) {
	h := newHarness(t)
	tagged := h.seedEvent("很久以前的 #工作", "manual", 1_600_000_000, "")
	h.seedTag(tagged, "工作")
	h.seedEvent("另一条 #个人", "manual", 1_600_000_100, "")

	rec := h.do(http.MethodGet,
		"/api/events?date=2024-01-10T00:00:00Z&tags="+url.QueryEscape("工作"), "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeEvents(t, rec.Body.Bytes())
	if len(resp.Events) != 1 || resp.Events[0].ID != tagged {
		t.Fatalf("events = %+v, want only the tagged one (date must be skipped)", resp.Events)
	}
}

// POST：创建手动事件并在同一事务里同步标签/引用/计划引用（ADR-0012、ADR-0016）。
func TestEventsPostCreatesManualEventAndSyncsTags(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events",
		`{"content":"完成评审 #成果 #工作","eventTime":"2024-01-10T10:00:00"}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Content != "完成评审 #成果 #工作" || created.Source != "manual" {
		t.Fatalf("created = %+v", created)
	}
	// eventTime 是按本地时区解释的 naive 时间，响应里是 UTC ISO。
	if created.EventTime != "2024-01-10T02:00:00.000Z" && created.EventTime != "2024-01-10T10:00:00.000Z" {
		t.Fatalf("eventTime = %q", created.EventTime)
	}
	if created.Metadata != nil {
		t.Fatalf("metadata = %+v, want null", created.Metadata)
	}
	if created.IsImportant == nil || *created.IsImportant {
		t.Fatalf("isImportant = %v, want false", created.IsImportant)
	}

	var tagCount int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM event_tags WHERE event_id = ?`, created.ID).Scan(&tagCount); err != nil {
		t.Fatal(err)
	}
	if tagCount != 2 {
		t.Fatalf("tag rows = %d, want 2", tagCount)
	}
	var tagName string
	if err := h.sqlDB.QueryRow(`SELECT tag_name FROM event_tags WHERE event_id = ? ORDER BY tag_name LIMIT 1`, created.ID).Scan(&tagName); err != nil {
		t.Fatal(err)
	}
	// ORDER BY tag_name 是 SQLite 的 BINARY 排序（码点序）：工作(U+5DE5) < 成果(U+6210)。
	if tagName != "工作" {
		t.Fatalf("tag = %q, want 工作", tagName)
	}
}

func TestEventsPostRejectsEmptyContent(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events", `{"content":""}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	msg, code := decodeError(t, rec.Body.Bytes())
	if msg != "Content is required" || code != "INVALID_CONTENT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestEventsPostRejectsWhitespaceOnlyContent(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events", `{"content":"   "}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if _, code := decodeError(t, rec.Body.Bytes()); code != "INVALID_CONTENT" {
		t.Fatalf("code = %q", code)
	}
}

func TestEventsPostRejectsMissingContent(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events", `{"eventTime":"2024-01-10T10:00:00"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Content is required" || code != "INVALID_CONTENT" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestEventsPostRejectsInvalidEventTime(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events", `{"content":"Test event","eventTime":"invalid-date"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Invalid event time" || code != "INVALID_EVENT_TIME" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

func TestEventsPostAcceptsValidEventTime(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events",
		`{"content":"Test event","eventTime":"2024-01-15T14:30:00.000Z"}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.EventTime != "2024-01-15T14:30:00.000Z" {
		t.Fatalf("eventTime = %q", created.EventTime)
	}
}

func TestEventsPostAcceptsContentWithoutEventTime(t *testing.T) {
	h := newHarness(t)

	before := time.Now().Unix()
	rec := h.do(http.MethodPost, "/api/events", `{"content":"Test event"}`, testPassword)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created eventsBodyJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", created.EventTime)
	if err != nil {
		t.Fatalf("eventTime %q: %v", created.EventTime, err)
	}
	// 秒级存储：允许前后 2s 的抖动。
	if diff := parsed.Unix() - before; diff < -2 || diff > 2 {
		t.Fatalf("eventTime %v not near now (%d)", parsed, before)
	}
}

// route.ts 里 request.json() 抛错 → 500 CREATE_ERROR（不是 400）。
func TestEventsPostRejectsInvalidJSONWith500(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events", "not-json", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if msg, code := decodeError(t, rec.Body.Bytes()); msg != "Failed to create event" || code != "CREATE_ERROR" {
		t.Fatalf("error = %q/%q", msg, code)
	}
}

// 票内点名：JSON body 为 null 时解构抛错，同样走 catch。
func TestEventsPostTreatsNullBodyAsServerError(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/events", "null", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if _, code := decodeError(t, rec.Body.Bytes()); code != "CREATE_ERROR" {
		t.Fatalf("code = %q", code)
	}
}

// 标签筛选是全量查询：跳过日期条件，多 tag 之间是 OR（EXISTS + IN）。
func TestEventsGetFiltersByTags(t *testing.T) {
	h := newHarness(t)
	makeEvent := func(marker, content string, tags []string, offset int64) {
		id := h.seedEvent(marker+" "+content, "manual", 1_600_000_000+offset, "")
		for _, tag := range tags {
			h.seedTag(id, tag)
		}
	}
	makeEvent("tagfilter-single", "个人事项", []string{"个人"}, 0)
	makeEvent("tagfilter-single", "工作事项", []string{"工作"}, 100)

	t.Run("single tag", func(t *testing.T) {
		rec := h.do(http.MethodGet, "/api/events?limit=30&tags="+url.QueryEscape("个人"), "", testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		resp := decodeEvents(t, rec.Body.Bytes())
		if len(resp.Events) != 1 || !strings.Contains(resp.Events[0].Content, "个人事项") {
			t.Fatalf("events = %+v", resp.Events)
		}
	})

	t.Run("multiple tags are OR", func(t *testing.T) {
		rec := h.do(http.MethodGet,
			"/api/events?limit=30&tags="+url.QueryEscape("个人")+","+url.QueryEscape("工作"), "", testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if resp := decodeEvents(t, rec.Body.Bytes()); len(resp.Events) != 2 {
			t.Fatalf("events = %d, want 2", len(resp.Events))
		}
	})

	t.Run("unused tag yields empty page", func(t *testing.T) {
		rec := h.do(http.MethodGet, "/api/events?limit=30&tags="+url.QueryEscape("确定不存在的标签xyz"), "", testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		resp := decodeEvents(t, rec.Body.Bytes())
		if resp.Events == nil || len(resp.Events) != 0 {
			t.Fatalf("events = %+v, want []", resp.Events)
		}
	})
}

// 票内点名：列表查询带 commentReferrerCount（被计划项评论引用的次数）。
func TestEventsGetCountsCommentReferrers(t *testing.T) {
	h := newHarness(t)
	cited := h.seedEvent("Cited event", "manual", 1_760_000_000, "")
	plain := h.seedEvent("Plain event", "manual", 1_759_913_600, "")
	item := h.seedPlanItem()
	h.citeComment(item, cited)
	h.citeComment(item, cited)

	rec := h.do(http.MethodGet, "/api/events", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeEvents(t, rec.Body.Bytes())
	byID := map[int64]*int64{}
	for _, ev := range resp.Events {
		byID[ev.ID] = ev.CommentReferrerCount
	}
	if byID[cited] == nil || *byID[cited] != 2 {
		t.Fatalf("cited count = %v, want 2", byID[cited])
	}
	if byID[plain] == nil || *byID[plain] != 0 {
		t.Fatalf("plain count = %v, want 0", byID[plain])
	}
}
