package collect

import (
	"math"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
)

// 本文件是 collect 域用到的时间语义：drizzle timestamp 列是 Unix 秒，
// JS 侧输出一律经 toISOString()。

// unixSeconds 复刻 drizzle 的 mapToDriverValue：Math.floor(ms / 1000)。
// 用 floor 而不是整数除法：负数时间戳（1970 前）两者的舍入方向不同。
func unixSeconds(t time.Time) int64 {
	return int64(math.Floor(float64(t.UnixMilli()) / 1000))
}

// isoMillisFromTime 复刻 `date.toISOString()`：UTC、毫秒三位、Z 后缀。
func isoMillisFromTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// parseJSTime 复刻 `new Date(value)`，ok=false 对应 Invalid Date。
func parseJSTime(value any) (time.Time, bool) {
	switch v := value.(type) {
	case string:
		parsed := jsdate.ParseString(v)
		if !parsed.Valid {
			return time.Time{}, false
		}
		return time.UnixMilli(parsed.Millis).UTC(), true
	case float64:
		parsed := jsdate.FromMillis(v)
		if !parsed.Valid {
			return time.Time{}, false
		}
		return time.UnixMilli(parsed.Millis).UTC(), true
	case bool:
		// new Date(true) === new Date(1)
		if v {
			return time.UnixMilli(1).UTC(), true
		}
		return time.UnixMilli(0).UTC(), true
	case nil:
		// new Date(null) === new Date(0)
		return time.UnixMilli(0).UTC(), true
	}
	return time.Time{}, false
}
