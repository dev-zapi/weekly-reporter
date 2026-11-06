package jsdate

import (
	"testing"
	"time"
)

// 本文件的期望值全部由 Node 24 实测得到（`new Date(v).toISOString()`）：
// 只写日期的形式按 UTC，带时间的形式按本地，越界字段按 V8 的归一化行为。

func TestParseStringDateOnlyIsUTC(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"2024-01-10", "2024-01-10T00:00:00.000Z"},
		{"2024-01", "2024-01-01T00:00:00.000Z"},
		{"2024", "2024-01-01T00:00:00.000Z"},
	}
	for _, tc := range cases {
		parsed := ParseString(tc.input)
		if !parsed.Valid {
			t.Fatalf("ParseString(%q) invalid", tc.input)
		}
		if got := iso(parsed.Millis); got != tc.want {
			t.Fatalf("ParseString(%q) = %s, want %s", tc.input, got, tc.want)
		}
	}
}

func TestParseStringDateTimeIsLocal(t *testing.T) {
	// 本地时区下 `2024-01-10T10:00:00` 与 `2024-01-10 10:00:00` 是同一时刻；
	// 断言用「本地日历字段」表达，避免测试依赖 CI 的 TZ。
	cases := []string{
		"2024-01-10T10:00:00",
		"2024-01-10T10:00",
		"2024-01-10 10:00:00",
	}
	for _, input := range cases {
		parsed := ParseString(input)
		if !parsed.Valid {
			t.Fatalf("ParseString(%q) invalid", input)
		}
		lt := time.UnixMilli(parsed.Millis).In(time.Local)
		if lt.Hour() != 10 || lt.Minute() != 0 || lt.Day() != 10 || lt.Month() != time.January {
			t.Fatalf("ParseString(%q) local = %v", input, lt)
		}
	}
}

func TestParseStringExplicitZone(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"2024-01-10T10:00:00.000Z", "2024-01-10T10:00:00.000Z"},
		{"2024-01-10T10:00:00+08:00", "2024-01-10T02:00:00.000Z"},
		{"2024-01-10T10:00:00+0800", "2024-01-10T02:00:00.000Z"},
		{"2024-01-10T10:00:00-05:00", "2024-01-10T15:00:00.000Z"},
		// 小数秒按毫秒截断（V8 只保留三位）。
		{"2024-01-10T10:00:00.1234Z", "2024-01-10T10:00:00.123Z"},
		// 24:00 归一到次日零点。
		{"2024-01-10T24:00:00Z", "2024-01-11T00:00:00.000Z"},
		// 日期越界按归一化：2 月 31 日 = 3 月 2 日。
		{"2024-02-31", "2024-03-02T00:00:00.000Z"},
	}
	for _, tc := range cases {
		parsed := ParseString(tc.input)
		if !parsed.Valid {
			t.Fatalf("ParseString(%q) invalid", tc.input)
		}
		if got := iso(parsed.Millis); got != tc.want {
			t.Fatalf("ParseString(%q) = %s, want %s", tc.input, got, tc.want)
		}
	}
}

func TestParseStringRejectsInvalid(t *testing.T) {
	cases := []string{
		"",
		"invalid-date",
		"not-a-date",
		"2024-13-01",
		"2024-00-01",
		"2024-01-32",
		"2024-01-10T25:00:00",
		"2024-01-10T10:60:00",
		" 2024-01-10T00:00:00",
		"2024-01-10T00:00:00 ",
	}
	for _, input := range cases {
		if parsed := ParseString(input); parsed.Valid {
			t.Fatalf("ParseString(%q) = %s, want invalid", input, iso(parsed.Millis))
		}
	}
}

// ParseString("T00:00:00") 是 date 参数缺省时 route.ts 的实际输入（空串 + 'T00:00:00'）。
// `new Date('T00:00:00')` 是 Invalid Date，所以 date 过滤被静默跳过。
func TestParseStringEmptyPrefixIsInvalid(t *testing.T) {
	if parsed := ParseString("T00:00:00"); parsed.Valid {
		t.Fatalf("ParseString(\"T00:00:00\") = %s, want invalid", iso(parsed.Millis))
	}
}

func TestFromMillisTimeClip(t *testing.T) {
	if parsed := FromMillis(0); !parsed.Valid {
		t.Fatalf("FromMillis(0) invalid")
	}
	// ECMAScript 的 TimeClip 上限 8.64e15。
	if parsed := FromMillis(8.64e15 + 1); parsed.Valid {
		t.Fatalf("FromMillis(over max) = %s, want invalid", iso(parsed.Millis))
	}
	// 向零截断。
	parsed := FromMillis(1700000000123.9)
	if parsed.Millis != 1700000000123 {
		t.Fatalf("FromMillis = %d, want truncation", parsed.Millis)
	}
}

func iso(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}
