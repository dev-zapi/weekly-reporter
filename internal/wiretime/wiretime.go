// Package wiretime implements the shared wire-level time contract for HTTP
// handlers and AI generation tools: date, week and month parameters are
// RFC3339 timestamps carrying the caller's explicit offset.
//
// 服务器自身时区不参与任何用户语义（issue #135）。周期键仍是 date-only 文本：
// 入参时刻按请求自带偏移折算到日历日后才参与存储与比较。
package wiretime

import (
	"net/http"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// InstantExample 是日期/窗口参数 400 文案里给出的合法 wire 形态示例（保留
// 客户端偏移）。所有家族的解析与拒绝都经过本包，示例因此只有这一份。
const InstantExample = "2026-11-03T00:00:00+08:00"

// DateFilterFormatMessage 是 AI 工具（query_report_list）日期参数的错误后缀。
// 与 HTTP 家族的 400 共用 InstantExample，避免示例文案漂移。
const DateFilterFormatMessage = "must be an RFC3339 timestamp with an offset, e.g. " + InstantExample

// InvalidInstantParam 写统一的 400：date-only、naive datetime、裸 yyyy-MM 与
// 畸形偏移都会走到这里，调用方只负责给出字段名与家族错误码。
func InvalidInstantParam(w http.ResponseWriter, name, code string) {
	respond.Error(
		w,
		http.StatusBadRequest,
		"Invalid "+name+": expected an RFC3339 timestamp with an explicit offset, e.g. "+InstantExample,
		code,
	)
}

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
