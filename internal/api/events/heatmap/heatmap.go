// Package heatmap 把只读聚合路由（`GET /api/events/heatmap`）挂到 chi 的 /api
// 子路由上。行为逐条对照 src/app/api/events/heatmap/route.ts。
package heatmap

import (
	"log"
	"net/http"
	"sort"
	"strconv"
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
// 路由在 /api 下扁平注册（而不是 r.Route 子树）：同批还有 /events、/events/{id}
// 与 /events/{id}/references 由其它票注册，扁平写法让 chi 自己按静态段优先匹配
// （/events/heatmap 胜过 /events/{id}），互不覆盖。
func Mount(r chi.Router, deps Deps) {
	r.Get("/events/heatmap", getHandler(deps))
}

const (
	// route.ts: `parseInt(new URL(request.url).searchParams.get('days') || '365') || 365`
	defaultDays = int64(365)
	// route.ts: Math.min(days, 730)
	maxDays = int64(730)
)

// jsMaxDays 是 "now - days" 落到 JS Date 可表示范围内的天数上限（±8.64e15 ms）。
// 越界时 new Date() 是 Invalid Date，绑进查询的 NaN 让 gte 恒不成立（零行）。
const jsMaxDays = int64(100_000_000)

// day 是响应 data 数组的一项。
type day struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

// getHandler 复刻 route.ts：
//   - tz 是必填的 IANA 时区名（#135 决策 5）：服务器本地时区不参与分组；缺参或
//     非法名 → 400 并附示例。tzdata 由二进制 embed（cmd/wr）；
//   - days 来自 parseInt，假值（NaN / 0 / 空串）回退 365，上限 clamp 到 730，
//     负数照抄（cutoff 被推到未来）；
//   - cutoff 走请求时区的日历减天数（setDate 语义），按 floor(ms/1000) 折成 Unix 秒；
//   - 聚合键是请求时区的 YYYY-MM-DD，只输出有事件的日子（不补零）；
//   - 按 date 字符串降序；空结果是 [] 而不是 null；
//   - 500 走 {error, code:'FETCH_ERROR'}。
func getHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		timeZone := r.URL.Query().Get("tz")
		// "Local" is Go's alias for the process zone, not an IANA name; accepting
		// it would put the server's own time zone back into user-visible semantics.
		loc, err := time.LoadLocation(timeZone)
		if timeZone == "" || timeZone == "Local" || err != nil {
			respond.Error(
				w,
				http.StatusBadRequest,
				"Invalid tz: expected an IANA time zone name, e.g. Asia/Shanghai",
				"INVALID_TZ",
			)
			return
		}

		days := parseDays(r.URL.Query().Get("days"))

		cutoff, ok := cutoffSeconds(time.Now(), days, loc)
		var times []int64
		if ok {
			var err error
			times, err = deps.Queries.ListHeatmapEventTimes(r.Context(), cutoff)
			if err != nil {
				log.Printf("Error fetching heatmap data: %v", err)
				respond.Error(w, http.StatusInternalServerError, "Failed to fetch heatmap data", "FETCH_ERROR")
				return
			}
		}

		counts := make(map[string]int64, len(times))
		for _, sec := range times {
			counts[dayKey(sec, loc)]++
		}

		// 空结果必须是 [] 而不是 null（客户端直接对 data 做数组操作）。
		data := make([]day, 0, len(counts))
		for date, count := range counts {
			data = append(data, day{Date: date, Count: count})
		}
		// route.ts 的 sort((a, b) => b.date.localeCompare(a.date))：键是定宽
		// YYYY-MM-DD，ICU 排序与字节排序一致，所以这里直接比字符串降序。
		sort.Slice(data, func(i, j int) bool { return data[i].Date > data[j].Date })

		respond.JSON(w, http.StatusOK, struct {
			Data []day `json:"data"`
		}{Data: data})
	}
}

// parseDays 复刻
//
//	Math.min(parseInt(searchParams.get('days') || '365') || 365, 730)
//
// 缺省与空串被 `|| '365'` 吃掉；parseInt 的 NaN 与 0 是假值，也被 `|| 365` 吃掉；
// Math.min 只对上限生效——负数原样保留（route.ts 因此会把 cutoff 推到未来）。
func parseDays(raw string) int64 {
	if raw == "" {
		return defaultDays
	}
	n, ok := jsparse.ParseInt(raw)
	if !ok || n == 0 {
		return defaultDays
	}
	if n > maxDays {
		return maxDays
	}
	return n
}

// cutoffSeconds 复刻
//
//	const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - days)
//	where(gte(rawEvents.eventTime, cutoff))
//
// setDate 保留时分秒、只移动日历日（在请求时区里，DST 正确），折成绑定值时
// drizzle 的 timestamp 映射是 Math.floor(ms / 1e3)。ok=false 表示 JS 侧是
// Invalid Date（超出 ±8.64e15 ms）：NaN 绑进 SQLite 后 `event_time >= NaN`
// 恒不成立，即零行。
func cutoffSeconds(now time.Time, days int64, loc *time.Location) (int64, bool) {
	// 先挡掉会把日历运算撑爆的量级：JS Date 只表示 ±1e8 天，越界即 Invalid Date。
	if days > jsMaxDays || days < -jsMaxDays {
		return 0, false
	}

	local := now.In(loc)
	year, month, dayOfMonth := local.Date()
	cutoff := time.Date(
		year, month, dayOfMonth-int(days),
		local.Hour(), local.Minute(), local.Second(), local.Nanosecond(),
		loc,
	)

	// 落回 wall clock 之后仍可能越界（now 本身靠近期边界），按同一 Invalid Date 处理。
	const jsMaxTimeMillis = 8.64e15
	ms := cutoff.UnixMilli()
	if ms > jsMaxTimeMillis || ms < -jsMaxTimeMillis {
		return 0, false
	}

	// Math.floor(ms / 1e3)：负数毫秒要向负无穷取整（Go 的整除向零取整）。
	sec := ms / 1000
	if ms < 0 && ms%1000 != 0 {
		sec--
	}
	return sec, true
}

// dayKey 复刻聚合键 `${getFullYear()}-${pad(getMonth()+1)}-${pad(getDate())}`：
// 事件时刻按请求时区（tz 参数）落到日历日，服务器本地时区不参与。
//
// 年月日分别手写而不是用 Go 的 "2006-01-02"：JS 的 getFullYear() 不补零（公元
// 1000 年以前是 "999"，不是 "0999"），只有月和日走 padStart(2,'0')。
func dayKey(unixSeconds int64, loc *time.Location) string {
	t := time.Unix(unixSeconds, 0).In(loc)
	year, month, dayOfMonth := t.Date()
	return strconv.Itoa(year) + "-" + pad2(int(month)) + "-" + pad2(dayOfMonth)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}
