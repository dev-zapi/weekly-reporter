package plans

import (
	"strconv"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/wiretime"
)

// 本文件移植 src/lib/periods.ts，但周期语义改为按请求自带偏移解释：
// 日期/周界/月界参数是 RFC3339 带偏移时刻，服务端只取该时刻在其偏移下的
// 日历读数；服务器自身时区不参与任何用户语义（issue #135/#138）。
//
// 周期键（period_start/period_end/month_key）仍是 date-only 文本：入参时刻
// 折算成键后才进查询与响应，存储形态不变。

// parseOffsetInstant 是 wiretime.ParseOffsetInstant 的薄适配：RFC3339 的解析
// 与拒绝清单只有 wiretime 一份实现；这里取出保留入参偏移的绝对时刻，后续日历
// 读数（周/月）都按该偏移进行。
func parseOffsetInstant(value string) (time.Time, bool) {
	parsed, ok := wiretime.ParseOffsetInstant(value)
	if !ok {
		return time.Time{}, false
	}
	return parsed.Instant, true
}

func formatDate(t time.Time) string { return t.Format("2006-01-02") }

// weekPeriodRange 返回 date 所在自然周的周一..周日，日历读数按 date 自身
// 偏移解释（wire 入参是请求偏移；defer 的 date-only 键以 UTC 承载，两者都自洽）。
func weekPeriodRange(date time.Time) (start, end string) {
	// Go 的 Weekday 以周日为 0；date-fns 的 weekStartsOn:1 以周一为第一天。
	offset := (int(date.Weekday()) + 6) % 7
	first := time.Date(date.Year(), date.Month(), date.Day()-offset, 0, 0, 0, 0, date.Location())
	last := first.AddDate(0, 0, 6)
	return formatDate(first), formatDate(last)
}

// monthPeriodRange 返回 date 所在自然月的月键与首末日，年/月同样按 date 自身
// 偏移解释。
func monthPeriodRange(date time.Time) (monthKey, start, end string) {
	first := time.Date(date.Year(), date.Month(), 1, 0, 0, 0, 0, date.Location())
	return date.Format("2006-01"), formatDate(first), formatDate(first.AddDate(0, 1, -1))
}

// nextWeekPeriodRange 复刻 getNextWeekPeriodRange：入参是已存的 date-only
// 周期键，纯日历 +7 天后取周范围。用 UTC 承载，日期算术与服务器时区无关。
func nextWeekPeriodRange(weekStart string) (start, end string) {
	segments := strings.Split(weekStart, "-")
	year := numberOrZero(segments[0])
	month := 1
	if len(segments) > 1 {
		month = numberOrZero(segments[1])
	}
	day := 1
	if len(segments) > 2 {
		day = numberOrZero(segments[2])
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return weekPeriodRange(date.AddDate(0, 0, 7))
}

// nextMonthPeriodRange 复刻 getNextMonthPeriodRange：入参是已存的 date-only
// 月键，纯日历 +1 月后取月范围（含 monthKey）。
func nextMonthPeriodRange(monthKey string) (nextKey, start, end string) {
	segments := strings.Split(monthKey, "-")
	year := numberOrZero(segments[0])
	month := 1
	if len(segments) > 1 {
		month = numberOrZero(segments[1])
	}
	date := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	return monthPeriodRange(date.AddDate(0, 1, 0))
}

// numberOrZero 复刻 Number(segment)：空串是 0；非数字是 NaN —— 入参来自已存的
// date-only 周期键，这里对 NaN 退化成 0（与其他归一化结果一致的容错）。
func numberOrZero(segment string) int {
	n, err := strconv.Atoi(segment)
	if err != nil {
		return 0
	}
	return n
}
