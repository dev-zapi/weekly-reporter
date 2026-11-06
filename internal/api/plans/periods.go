package plans

import (
	"strconv"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
)

// 本文件移植 src/lib/periods.ts。date-fns 的默认时区是本地时区，
// `new Date(y, m-1, d)` 与 `format(date, 'yyyy-MM-dd')` 也都按本地日历解释，
// 所以这里一律用 time.Local，测试与线上行为随时区设置一致。

// isDateString 复刻 DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/（ASCII 数字）。
func isDateString(value string) bool {
	if len(value) != 10 {
		return false
	}
	for i := 0; i < len(value); i++ {
		switch i {
		case 4, 7:
			if value[i] != '-' {
				return false
			}
		default:
			if value[i] < '0' || value[i] > '9' {
				return false
			}
		}
	}
	return true
}

// isMonthString 复刻 MONTH_REGEX = /^\d{4}-\d{2}$/。
func isMonthString(value string) bool {
	if len(value) != 7 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if i == 4 {
			if value[i] != '-' {
				return false
			}
			continue
		}
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

// parseLocalDate 复刻 `new Date(value + 'T00:00:00')`：按本地时区解释，
// 非法日期（如 2026-13-01）返回 ok=false，对应 JS 的 Invalid Date。
func parseLocalDate(value string) (time.Time, bool) {
	parsed := jsdate.ParseString(value + "T00:00:00")
	if !parsed.Valid {
		return time.Time{}, false
	}
	return time.UnixMilli(parsed.Millis).In(time.Local), true
}

func formatDate(t time.Time) string { return t.Format("2006-01-02") }

// weekPeriodRange 复刻 getWeekPeriodRange：startOfWeek(weekStartsOn:1) 到
// endOfWeek，按本地日历取 yyyy-MM-dd。
func weekPeriodRange(date time.Time) (start, end string) {
	local := date.In(time.Local)
	// Go 的 Weekday 以周日为 0；date-fns 的 weekStartsOn:1 以周一为第一天。
	offset := (int(local.Weekday()) + 6) % 7
	first := time.Date(local.Year(), local.Month(), local.Day()-offset, 0, 0, 0, 0, time.Local)
	last := first.AddDate(0, 0, 6)
	return formatDate(first), formatDate(last)
}

// monthPeriodRange 复刻 getMonthPeriodRange：本地日历月的首末日与 yyyy-MM。
func monthPeriodRange(date time.Time) (monthKey, start, end string) {
	local := date.In(time.Local)
	first := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, time.Local)
	return local.Format("2006-01"), formatDate(first), formatDate(first.AddDate(0, 1, -1))
}

// monthPeriodRangeByKey 复刻 getMonthPeriodRangeByKey：
//
//	const [year, month] = monthKey.split('-').map(Number)
//	const date = new Date(year, month - 1, 1)
//
// JS Date 构造器对越界月份按年归一化（month=13 → 次年 1 月，month=0 → 上年 12 月），
// Go 的 time.Date 对越界月份同样归一化，所以 monthKey 的数值段可原样传入。
func monthPeriodRangeByKey(monthKey string) (start, end string) {
	segments := strings.Split(monthKey, "-")
	year := numberOrZero(segments[0])
	month := 0
	if len(segments) > 1 {
		month = numberOrZero(segments[1])
	}
	first := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.Local)
	return formatDate(first), formatDate(first.AddDate(0, 1, -1))
}

// numberOrZero 复刻 Number(segment)：空串是 0；非数字是 NaN —— MONTH_REGEX 已挡掉
// 非数字，这里对 NaN 退化成 0（同样会得到 Invalid Date 之外的归一化结果）。
func numberOrZero(segment string) int {
	n, err := strconv.Atoi(segment)
	if err != nil {
		return 0
	}
	return n
}

// nextWeekPeriodRange 复刻 getNextWeekPeriodRange：`new Date(y, m-1, d)` 后
// addWeeks(1)（本地日历 +7 天），再取周范围。
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
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.Local)
	return weekPeriodRange(date.AddDate(0, 0, 7))
}

// nextMonthPeriodRange 复刻 getNextMonthPeriodRange：`new Date(y, m-1, 1)` 后
// addMonths(1)，再取月范围（含 monthKey）。
func nextMonthPeriodRange(monthKey string) (nextKey, start, end string) {
	segments := strings.Split(monthKey, "-")
	year := numberOrZero(segments[0])
	month := 1
	if len(segments) > 1 {
		month = numberOrZero(segments[1])
	}
	date := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.Local)
	return monthPeriodRange(date.AddDate(0, 1, 0))
}
