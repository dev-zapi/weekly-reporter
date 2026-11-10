package heatmap_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 本文件是 src/app/api/events/heatmap/route.test.ts 的 Go 同用例集（ADR-0029）：
// 8 个用例逐条对应，另补 route.ts 里可观测的 days 解析边界（parseInt 前缀、
// 假值回退、clamp 上限、负值把 cutoff 推到未来）。
//
// 与 TS 的差异只有夹具形态：TS 用 vi.mock 替换 getDb 并按 case 摆好返回行，
// Go 写进真实 SQLite（同一个 schema.sql）再让 handler 自己查。因此「聚合」这件事
// 是被真 SQL 验证过的，而不是验证我们怎么拼 mock。
//
// 时区契约（#137）：请求必须带 IANA `tz`，服务端按该时区分组。用例统一用
// Asia/Shanghai（与测试进程本地时区无关），另外单独验证同一时刻在 UTC 与
// Shanghai 下落到不同日期键。

const testTZ = "Asia/Shanghai"

type heatmapResponse struct {
	Data []struct {
		Date  string `json:"date"`
		Count int64  `json:"count"`
	} `json:"data"`
}

func decodeHeatmap(t *testing.T, body []byte) heatmapResponse {
	t.Helper()

	var resp heatmapResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

// mustJSONKeys 返回响应体的顶层键集合，用来钉死 {error, code} 形状（不能多带字段）。
func mustJSONKeys(t *testing.T, rec *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()

	var got map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	return got
}

func mustLoadLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load location %q: %v", name, err)
	}
	return loc
}

// dayKey 是请求时区下的 YYYY-MM-DD 聚合键。
func dayKey(t *testing.T, instant time.Time, timeZone string) string {
	t.Helper()
	return instant.In(mustLoadLocation(t, timeZone)).Format("2006-01-02")
}

// startOfDay 取请求时区下当天的 00:00。
func startOfDay(t *testing.T, instant time.Time, timeZone string) time.Time {
	t.Helper()
	loc := mustLoadLocation(t, timeZone)
	local := instant.In(loc)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
}

func TestHeatmapGroupsByDay(t *testing.T) {
	h := newHarness(t)
	today := startOfDay(t, time.Now(), testTZ)
	yesterday := today.AddDate(0, 0, -1)

	h.seedEvent(today.Add(10 * time.Hour).Unix())
	h.seedEvent(today.Add(14 * time.Hour).Unix())
	h.seedEvent(yesterday.Add(9 * time.Hour).Unix())

	rec := h.do("/api/events/heatmap?tz=" + testTZ)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp := decodeHeatmap(t, rec.Body.Bytes())
	if len(resp.Data) != 2 {
		t.Fatalf("data = %+v, want 2 days", resp.Data)
	}
	if resp.Data[0].Date != dayKey(t, today, testTZ) || resp.Data[0].Count != 2 {
		t.Fatalf("data[0] = %+v, want {%s 2}", resp.Data[0], dayKey(t, today, testTZ))
	}
	if resp.Data[1].Date != dayKey(t, yesterday, testTZ) || resp.Data[1].Count != 1 {
		t.Fatalf("data[1] = %+v, want {%s 1}", resp.Data[1], dayKey(t, yesterday, testTZ))
	}
}

func TestHeatmapDateIsZeroPaddedYMD(t *testing.T) {
	h := newHarness(t)
	today := startOfDay(t, time.Now(), testTZ)
	h.seedEvent(today.Add(10 * time.Hour).Unix())

	rec := h.do("/api/events/heatmap?tz=" + testTZ)
	resp := decodeHeatmap(t, rec.Body.Bytes())

	if len(resp.Data) != 1 {
		t.Fatalf("data = %+v, want 1 day", resp.Data)
	}
	// 单月单日也必须补零（route.ts 的 String(...).padStart(2,'0')）。
	if resp.Data[0].Date != dayKey(t, today, testTZ) {
		t.Fatalf("date = %q, want %q", resp.Data[0].Date, dayKey(t, today, testTZ))
	}
	if len(resp.Data[0].Date) != len("2006-01-02") {
		t.Fatalf("date = %q, want YYYY-MM-DD", resp.Data[0].Date)
	}
}

func TestHeatmapAggregatesEventsOnTheSameDay(t *testing.T) {
	h := newHarness(t)
	today := startOfDay(t, time.Now(), testTZ)
	h.seedEvent(today.Add(8 * time.Hour).Unix())
	h.seedEvent(today.Add(12 * time.Hour).Unix())
	h.seedEvent(today.Add(18 * time.Hour).Unix())

	rec := h.do("/api/events/heatmap?tz=" + testTZ)
	resp := decodeHeatmap(t, rec.Body.Bytes())

	if len(resp.Data) != 1 {
		t.Fatalf("data = %+v, want a single day", resp.Data)
	}
	if resp.Data[0] != (struct {
		Date  string `json:"date"`
		Count int64  `json:"count"`
	}{dayKey(t, today, testTZ), 3}) {
		t.Fatalf("data[0] = %+v, want {%s 3}", resp.Data[0], dayKey(t, today, testTZ))
	}
}

func TestHeatmapEmptyResultIsEmptyArrayNotNull(t *testing.T) {
	h := newHarness(t)

	rec := h.do("/api/events/heatmap?tz=UTC")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// 空结果必须是 [] 而不是 null：客户端直接对 data 做数组操作。
	if got := rec.Body.String(); got != `{"data":[]}` {
		t.Fatalf("body = %s, want {\"data\":[]}", got)
	}
}

func TestHeatmapSkipsZeroFillAndSortsDescending(t *testing.T) {
	h := newHarness(t)
	today := startOfDay(t, time.Now(), testTZ)
	older := today.AddDate(0, 0, -4)

	h.seedEvent(today.Add(10 * time.Hour).Unix())
	h.seedEvent(older.Add(9 * time.Hour).Unix())

	rec := h.do("/api/events/heatmap?tz=" + testTZ)
	resp := decodeHeatmap(t, rec.Body.Bytes())

	if len(resp.Data) != 2 {
		t.Fatalf("data = %+v, want 2 days (no zero fill)", resp.Data)
	}
	for _, d := range resp.Data {
		if d.Count <= 0 {
			t.Fatalf("day %q has count %d, want > 0 (no zero fill)", d.Date, d.Count)
		}
	}
	if resp.Data[0].Date != dayKey(t, today, testTZ) || resp.Data[1].Date != dayKey(t, older, testTZ) {
		t.Fatalf("data = %+v, want %s before %s", resp.Data, dayKey(t, today, testTZ), dayKey(t, older, testTZ))
	}
}

// 数据库故障走 route.ts 的 catch：500 + {error, code}，而不是空数组。
func TestHeatmapDatabaseErrorReturns500(t *testing.T) {
	h := newHarness(t)
	h.seedEvent(startOfDay(t, time.Now(), testTZ).Unix())

	if err := h.sqlDB.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	rec := h.do("/api/events/heatmap?tz=UTC")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	got := mustJSONKeys(t, rec)

	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	if body.Error != "Failed to fetch heatmap data" || body.Code != "FETCH_ERROR" {
		t.Fatalf("body = %s, want FETCH_ERROR shape", rec.Body.String())
	}
	if len(got) != 2 {
		t.Fatalf("body must carry exactly {error, code}: %s", rec.Body.String())
	}
}

// days=30 必须真的收窄窗口：30 天内的事件在内，31 天前的不在。
func TestHeatmapAcceptsCustomDaysParameter(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	h.seedEvent(now.AddDate(0, 0, -3).Unix())
	h.seedEvent(now.AddDate(0, 0, -45).Unix())

	rec := h.do("/api/events/heatmap?days=30&tz=" + testTZ)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp := decodeHeatmap(t, rec.Body.Bytes())
	if len(resp.Data) != 1 {
		t.Fatalf("data = %+v, want only the 3-day-old event", resp.Data)
	}
	if resp.Data[0].Date != dayKey(t, now.AddDate(0, 0, -3), testTZ) {
		t.Fatalf("data[0] = %+v, want the recent day", resp.Data[0])
	}
}

// Math.min(days, 730) 的上限是硬上限：days=9999 也不看 800 天前的事件。
func TestHeatmapClampsDaysTo730(t *testing.T) {
	h := newHarness(t)
	h.seedEvent(time.Now().AddDate(0, 0, -800).Unix())

	rec := h.do("/api/events/heatmap?days=9999&tz=" + testTZ)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp := decodeHeatmap(t, rec.Body.Bytes())
	if len(resp.Data) != 0 {
		t.Fatalf("data = %+v, want empty (730-day clamp excludes 800 days ago)", resp.Data)
	}
}

// days 的解析逐条对照 route.ts 的
//
//	Math.min(parseInt(sp.get('days') || '365') || 365, 730)
//
// NaN 与 0 都是假值，`|| 365` 把它们拉回 365；parseInt 容忍尾随垃圾；缺省与空串
// 同样走 365。499 天前的事件是这些分支的可观测分界（365 排除它、500 包含它）。
// 刻意不用「正好 500 天」：handler 的 now 比夹具晚几微秒，跨整秒边界时 cutoff 会比
// 事件大 1 秒，用例会偶发假失败；499 天留出一天余量、分界语义不变。
func TestHeatmapDaysParsingMirrorsRouteTS(t *testing.T) {
	// 子测试名不能为空：空名时 Go 用 "#00" 拼临时目录，而 dbtest 的 file: DSN 会把
	// "#" 之后当 URI fragment，导致多个用例共用同一个库文件（第二例起报 table
	// already exists）。给缺省分支一个可读名字即可绕开。
	cases := []struct {
		name      string
		days      string
		wantEvent bool // 499 天前的事件是否落在窗口里
	}{
		{"default", "", false},                         // 缺省 → 365
		{"empty", "?days=", false},                     // 空串 → '365'
		{"nan", "?days=abc", false},                    // NaN → 365
		{"zero", "?days=0", false},                     // 0 是假值 → 365
		{"zero-prefixed-garbage", "?days=0abc", false}, // parseInt('0abc') = 0 → 365
		{"five-hundred", "?days=500", true},            // 500 天真窗口
		{"trailing-garbage", "?days=500abc", true},     // parseInt 前缀
		{"leading-zero", "?days=0300", false},          // parseInt('0300') = 300（十进制，无八进制）→ 排除 499 天
		{"hex", "?days=0x1f4", true},                   // parseInt 无 radix 时认 0x 前缀 = 500
		{"clamped", "?days=99999999999999", true},      // clamp 730 → 仍包含 499 天（clamp 本身由 TestHeatmapClampsDaysTo730 钉住）
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.seedEvent(time.Now().AddDate(0, 0, -499).Unix())

			query := tc.days
			if query == "" {
				query = "?tz=" + testTZ
			} else {
				query += "&tz=" + testTZ
			}
			rec := h.do("/api/events/heatmap" + query)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			resp := decodeHeatmap(t, rec.Body.Bytes())
			if got := len(resp.Data) == 1; got != tc.wantEvent {
				t.Fatalf("499-day-old event included = %t, want %t (data %+v)", got, tc.wantEvent, resp.Data)
			}
		})
	}
}

// 负 days 照抄 route.ts：Math.min(-5, 730) = -5，cutoff 被推到 5 天之后，
// 于是只有「5 天后」的事件进来。这是 parseInt 语义的产物，不是可修的自由度。
func TestHeatmapNegativeDaysPushesCutoffIntoTheFuture(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	h.seedEvent(now.Unix())
	h.seedEvent(now.AddDate(0, 0, 6).Unix())

	rec := h.do("/api/events/heatmap?days=-5&tz=" + testTZ)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp := decodeHeatmap(t, rec.Body.Bytes())
	if len(resp.Data) != 1 {
		t.Fatalf("data = %+v, want only the future event", resp.Data)
	}
	if resp.Data[0].Date != dayKey(t, now.AddDate(0, 0, 6), testTZ) {
		t.Fatalf("data[0] = %+v, want the future day", resp.Data[0])
	}
}

// 极大负 days 让 route.ts 的 `cutoff.setDate(...)` 越过 JS Date 的范围（±8.64e15 ms），
// cutoff 变成 Invalid Date → 绑进 SQLite 是 NaN → `event_time >= NaN` 恒不成立 → 零行。
// 注意 days 先过 Math.min(…, 730)，所以只有负向能走到这里。
func TestHeatmapHugeNegativeDaysYieldsInvalidDateAndNoRows(t *testing.T) {
	h := newHarness(t)
	h.seedEvent(time.Now().Unix())
	h.seedEvent(time.Now().AddDate(0, 0, -30).Unix())

	rec := h.do("/api/events/heatmap?days=-1e21&tz=" + testTZ) // parseInt('-1e21') = -1（尾随垃圾），窗口含今天
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	// -1 天：cutoff 是明天，今天的事件被排除 → 空数组。
	resp := decodeHeatmap(t, rec.Body.Bytes())
	if len(resp.Data) != 0 {
		t.Fatalf("data = %+v, want empty (cutoff pushed one day into the future)", resp.Data)
	}

	// 真正的 Invalid Date：days 是精确的极大负数。
	rec = h.do("/api/events/heatmap?days=-999999999999999&tz=" + testTZ)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp = decodeHeatmap(t, rec.Body.Bytes())
	if len(resp.Data) != 0 {
		t.Fatalf("data = %+v, want empty (Invalid Date → NaN → no rows)", resp.Data)
	}
}

// 缺 tz 是 400，错误信息必须给出 IANA 名称示例——服务器本地时区不再参与语义。
func TestHeatmapRequiresTimeZone(t *testing.T) {
	h := newHarness(t)

	rec := h.do("/api/events/heatmap")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	if body.Code != "INVALID_TZ" {
		t.Fatalf("code = %q, want INVALID_TZ", body.Code)
	}
	if !strings.Contains(body.Error, "IANA") || !strings.Contains(body.Error, "Asia/Shanghai") {
		t.Fatalf("message %q must name IANA zones and give an example", body.Error)
	}
}

func TestHeatmapRejectsUnknownTimeZone(t *testing.T) {
	h := newHarness(t)

	for _, timeZone := range []string{"Not%2FAZone", "Local"} {
		t.Run(timeZone, func(t *testing.T) {
			rec := h.do("/api/events/heatmap?tz=" + timeZone)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if got := mustJSONKeys(t, rec); len(got) != 2 {
				t.Fatalf("body must carry exactly {error, code}: %s", rec.Body.String())
			}
		})
	}
}

// 同一绝对时刻按请求时区分组：UTC 的 11-09 23:00 在上海已是 11-10 07:00。
func TestHeatmapGroupsByRequestedTimeZone(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	utc := now.UTC()
	utcMidnight := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	instant := utcMidnight.Add(-time.Hour)
	h.seedEvent(instant.Unix())

	for _, timeZone := range []string{"UTC", testTZ} {
		t.Run(timeZone, func(t *testing.T) {
			rec := h.do("/api/events/heatmap?tz=" + timeZone)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			resp := decodeHeatmap(t, rec.Body.Bytes())
			want := dayKey(t, instant, timeZone)
			if len(resp.Data) != 1 || resp.Data[0].Date != want {
				t.Fatalf("data = %+v, want one day keyed %s", resp.Data, want)
			}
		})
	}
}

// DST fall-back day in America/New_York is 25 hours long. An event at 00:30
// (EDT) and one at 23:30 (EST) on the same calendar day must share one bucket;
// their UTC projections fall on two different dates, so this pins that grouping
// follows the requested IANA zone (DST included), not UTC.
func TestHeatmapGroupsAcrossDSTFallBack(t *testing.T) {
	h := newHarness(t)
	loc := mustLoadLocation(t, "America/New_York")
	dstDay := mostRecentFirstSundayOfNovember(time.Now().In(loc), loc)

	early := time.Date(dstDay.Year(), dstDay.Month(), dstDay.Day(), 0, 30, 0, 0, loc)
	late := time.Date(dstDay.Year(), dstDay.Month(), dstDay.Day(), 23, 30, 0, 0, loc)
	if early.UTC().Format("2006-01-02") == late.UTC().Format("2006-01-02") {
		t.Fatalf("fixture must straddle UTC midnight: early=%s late=%s", early.UTC(), late.UTC())
	}
	h.seedEvent(early.Unix())
	h.seedEvent(late.Unix())

	rec := h.do("/api/events/heatmap?tz=America%2FNew_York")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	resp := decodeHeatmap(t, rec.Body.Bytes())
	want := dstDay.Format("2006-01-02")
	if len(resp.Data) != 1 || resp.Data[0].Date != want || resp.Data[0].Count != 2 {
		t.Fatalf("data = %+v, want one day {%s 2}", resp.Data, want)
	}
}

// mostRecentFirstSundayOfNovember returns the most recent US DST fall-back day
// at or before now (first Sunday of November).
func mostRecentFirstSundayOfNovember(now time.Time, loc *time.Location) time.Time {
	first := time.Date(now.Year(), time.November, 1, 0, 0, 0, 0, loc)
	firstSunday := first.AddDate(0, 0, (7-int(first.Weekday()))%7)
	if firstSunday.After(now) {
		first = time.Date(now.Year()-1, time.November, 1, 0, 0, 0, 0, loc)
		firstSunday = first.AddDate(0, 0, (7-int(first.Weekday()))%7)
	}
	return firstSunday
}
