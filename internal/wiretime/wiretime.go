// Package wiretime implements the shared wire-level time contract for HTTP
// handlers and AI generation tools: date, week and month parameters are
// RFC3339 timestamps carrying the caller's explicit offset.
//
// 服务器自身时区不参与任何用户语义（issue #135）。周期键仍是 date-only 文本：
// 入参时刻按请求自带偏移折算到日历日后才参与存储与比较。
package wiretime

import "time"

// OffsetInstant 是一个合法 wire 时刻的三种投影。Key 是由请求偏移决定的日历日
// （周期键）；Location 是该偏移对应的固定时区，供窗口取整使用；Instant 是绝对
// 时刻，仅用于先后比较。
type OffsetInstant struct {
	Key      string
	Location *time.Location
	Instant  time.Time
}

// ParseOffsetInstant 用 time.Parse(RFC3339) 解析带偏移时刻（Z 或 ±HH:MM）。
// date-only（2026-11-03）、naive datetime（2026-11-03T00:00:00）与裸 yyyy-MM
// 都不是 instant，解析失败；日历日按请求偏移取整，不经过服务器时区。
func ParseOffsetInstant(value string) (OffsetInstant, bool) {
	instant, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return OffsetInstant{}, false
	}
	_, offset := instant.Zone()
	location := time.FixedZone("", offset)
	return OffsetInstant{
		Key:      instant.In(location).Format("2006-01-02"),
		Location: location,
		Instant:  instant,
	}, true
}
