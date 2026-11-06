// Package jsdate 复刻 JavaScript `new Date(value)` 在 freeze 契约里的可观测语义。
//
// 为什么需要它：events 域的 weekStart/weekEnd/date/eventTime 全部经 `new Date()`
// 解释，而 JS 与 Go 的差别是可观测的：
//   - 只写日期的字符串（`2024-01-08`）按 UTC 解释，而 `2024-01-08T00:00` 按本地；
//   - `setHours(23,59,59,999)` 作用在本地时区的日历日上；
//   - 非数字字符串得到 Invalid Date（NaN），route.ts 据此走不同分支；
//   - 数值/布尔按毫秒（布尔为 0/1）。
//
// 支持的输入 = ECMAScript 的 Date Time String Format（含 V8 普遍接受的空格式
// 「日期 时间」变体，因为 `2024-01-10 10:00:00` 在 V8 里同样有效）。
//
// 边界（有意收窄，非 V8 全量对等）：V8 在该格式之外还走一套宽松的历史解析器，
// 它接受 ` 2024-01-08 `（首尾空白）、`2024-1-8`（单数字月日）、`0`、五位年份、
// `Jan 10 2024` 等写法（其中 date-only 形态按本地时间解释，与严格格式的 UTC
// 不同）。这些形态都没有出现在任何冻结契约的消费者与 e2e 里，本包统一按
// Invalid Date 处理，只复刻 route.ts 在正常输入下的可观测分支。
//
// 消费者同样跨出路由层：B6 起 internal/engine、internal/generation 与
// internal/reports 直接消费本包（时间戳与 ISO 串换算）。
package jsdate

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// Parsed 是 `new Date(value)` 的结果。Valid=false 对应 JS 的 Invalid Date。
type Parsed struct {
	// Millis 是 epoch 毫秒；Valid=false 时无意义。
	Millis int64
	Valid  bool
}

// invalid 是 Invalid Date 的哨兵值。
func invalid() Parsed { return Parsed{} }

// FromMillis 复刻 `new Date(number)`。
func FromMillis(ms float64) Parsed {
	if math.IsNaN(ms) || math.IsInf(ms, 0) {
		return invalid()
	}
	// ECMAScript 的 TimeClip：|ms| > 8.64e15 越界为 Invalid，且向零截断。
	const maxTime = 8.64e15
	if ms > maxTime || ms < -maxTime {
		return invalid()
	}
	return Parsed{Millis: int64(ms), Valid: true}
}

// ParseString 复刻 `new Date(string)` 对 Date Time String Format 的解释。
func ParseString(value string) Parsed {
	// 按 Date Time String Format 严格解析：两端空白即 Invalid（T 形态 V8 也如此，
	// date-only 形态 V8 会 trim 后按本地时间解释——见包注释里的边界说明）。
	s := value
	if s == "" {
		return invalid()
	}
	if strings.TrimSpace(s) != s {
		return invalid()
	}

	// 时区后缀：Z、±HH:MM、±HHMM。
	zone := "local"
	body := s
	if strings.HasSuffix(body, "Z") || strings.HasSuffix(body, "z") {
		zone = "utc"
		body = body[:len(body)-1]
	} else if len(body) >= 6 {
		tail := body[len(body)-6:]
		if (tail[0] == '+' || tail[0] == '-') && tail[3] == ':' && isDigits(tail[1:3]) && isDigits(tail[4:6]) {
			zone = tail
			body = body[:len(body)-6]
		} else if len(body) >= 5 {
			tail = body[len(body)-5:]
			if (tail[0] == '+' || tail[0] == '-') && isDigits(tail[1:]) {
				zone = tail[:3] + ":" + tail[3:]
				body = body[:len(body)-5]
			}
		}
	}

	datePart, timePart := body, ""
	if idx := strings.IndexAny(body, "T"); idx >= 0 {
		datePart, timePart = body[:idx], body[idx+1:]
	} else if idx := strings.Index(body, " "); idx >= 0 {
		datePart, timePart = body[:idx], body[idx+1:]
	}

	year, month, day, ok := parseDatePart(datePart)
	if !ok {
		return invalid()
	}
	// 只有日期部分时按 UTC（ES 的 date-only 形式），否则按本地或显式时区。
	if timePart == "" {
		if zone == "local" {
			zone = "utc"
		}
	}

	hour, minute, second, millis, ok := parseTimePart(timePart)
	if !ok {
		return invalid()
	}

	loc, offsetMinutes := zoneLocation(zone)
	t := time.Date(year, time.Month(month), day, hour, minute, second, millis*int(time.Millisecond), loc)
	if offsetMinutes != 0 {
		t = t.Add(-time.Duration(offsetMinutes) * time.Minute)
	}
	return FromMillis(float64(t.UnixMilli()))
}

// parseDatePart 解析 YYYY / YYYY-MM / YYYY-MM-DD。字段越界时按 V8 的行为处理：
// 月份必须 1–12，日允许溢出到下个月（`2024-02-31` → 3 月 2 日）。
func parseDatePart(part string) (year, month, day int, ok bool) {
	segments := strings.Split(part, "-")
	if len(segments) < 1 || len(segments) > 3 {
		return 0, 0, 0, false
	}
	if !isDigits(segments[0]) || len(segments[0]) != 4 {
		return 0, 0, 0, false
	}
	year, _ = strconv.Atoi(segments[0])
	month, day = 1, 1
	if len(segments) >= 2 {
		if !isDigits(segments[1]) || len(segments[1]) != 2 {
			return 0, 0, 0, false
		}
		month, _ = strconv.Atoi(segments[1])
		if month < 1 || month > 12 {
			return 0, 0, 0, false
		}
	}
	if len(segments) == 3 {
		if !isDigits(segments[2]) || len(segments[2]) != 2 {
			return 0, 0, 0, false
		}
		day, _ = strconv.Atoi(segments[2])
		if day < 1 || day > 31 {
			return 0, 0, 0, false
		}
	}
	return year, month, day, true
}

// parseTimePart 解析 HH:MM / HH:MM:SS / HH:MM:SS.sss。小时允许 24（仅当分秒为 0，
// 与 V8 一致），其余字段按常规范围校验。
func parseTimePart(part string) (hour, minute, second, millis int, ok bool) {
	if part == "" {
		return 0, 0, 0, 0, true
	}

	fraction := ""
	if idx := strings.Index(part, "."); idx >= 0 {
		fraction = part[idx+1:]
		part = part[:idx]
		if !isDigits(fraction) || len(fraction) == 0 {
			return 0, 0, 0, 0, false
		}
		// 只取前三位，多余的按 V8 截断。
		if len(fraction) > 3 {
			fraction = fraction[:3]
		}
		for len(fraction) < 3 {
			fraction += "0"
		}
		millis, _ = strconv.Atoi(fraction)
	}

	segments := strings.Split(part, ":")
	if len(segments) < 2 || len(segments) > 3 {
		return 0, 0, 0, 0, false
	}
	for _, segment := range segments {
		if !isDigits(segment) || len(segment) != 2 {
			return 0, 0, 0, 0, false
		}
	}
	hour, _ = strconv.Atoi(segments[0])
	minute, _ = strconv.Atoi(segments[1])
	if len(segments) == 3 {
		second, _ = strconv.Atoi(segments[2])
	}

	if minute > 59 || second > 59 {
		return 0, 0, 0, 0, false
	}
	if hour > 24 || (hour == 24 && (minute != 0 || second != 0 || millis != 0)) {
		return 0, 0, 0, 0, false
	}
	return hour, minute, second, millis, true
}

// zoneLocation 把时区后缀折成 time.Location 与额外分钟偏移。
// "local" 用 time.Local；显式偏移用 UTC 加换算（避免依赖 tzdata 里不存在的区名）。
func zoneLocation(zone string) (*time.Location, int) {
	switch zone {
	case "utc":
		return time.UTC, 0
	case "local":
		return time.Local, 0
	}

	sign := 1
	if zone[0] == '-' {
		sign = -1
	}
	hours, _ := strconv.Atoi(zone[1:3])
	minutes, _ := strconv.Atoi(zone[4:6])
	return time.UTC, sign * (hours*60 + minutes)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// IsValid 是 Valid 的可读别名，便于调用方写 `if !p.Valid`。
func (p Parsed) IsValid() bool { return p.Valid }

// FromUnix 把 epoch 秒折成毫秒（Go 侧存储单位是秒）。
func FromUnix(sec int64) Parsed { return Parsed{Millis: sec * 1000, Valid: true} }

// ISOString 复刻 `Date.prototype.toISOString()`：UTC、毫秒三位、Z 后缀。
func ISOString(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z")
}

// ISOStringFromUnix 复刻 `new Date(seconds * 1000).toISOString()`，用于 drizzle
// timestamp 列（Unix 秒）的响应序列化。
func ISOStringFromUnix(seconds int64) string {
	return ISOString(seconds * 1000)
}
