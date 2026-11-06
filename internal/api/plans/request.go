package plans

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
)

// 本文件是各 handler 共用的请求体读取与 JS 值语义辅助。

// decodeJSON 复刻 `await request.json()`：读整个 body 再解析。
// 解析失败与 route.ts 一样是错误（落进各 handler 的 catch → 500）。
// 用 json.Unmarshal 而不是 Decoder：它拒绝尾随垃圾（JSON.parse 也拒绝），
// 并把数字折成 float64（JS 的 JSON.parse 产出的就是 IEEE-754 double）。
func decodeJSON(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}

// objectBody 把 body 折成字段视图。JS 里解构 `const { x } = body` 对标量也成立
// （字段全是 undefined），只有 null/undefined 会抛错——那一条由调用方的
// `rawBody == nil` 判断覆盖。数组同样没有已知字段，等价于空对象。
func objectBody(body any) map[string]any {
	switch value := body.(type) {
	case map[string]any:
		return value
	default:
		return map[string]any{}
	}
}

// truthyJSON 复刻 JS 的真值判断（`!periodPlanId`、`body.category` 这类短路条件）。
func truthyJSON(v any) bool {
	switch value := v.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case float64:
		return value != 0 && !math.IsNaN(value)
	case []any, map[string]any:
		return true
	}
	return false
}

// asID 复刻 drizzle 把 JSON 值绑进 integer 主键时的 SQLite 亲和性：
// 数字按数值、数字字符串按数值转换。非整数（1.5）不可能命中。
// 布尔/数组/对象不在这里处理：better-sqlite3 在绑定阶段就抛错，由
// unbindableJSON 的调用方映射成 route.ts 的 500 catch 分支。
func asID(v any) (int64, bool) {
	switch value := v.(type) {
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
			return 0, false
		}
		if value > math.MaxInt64 || value < math.MinInt64 {
			return 0, false
		}
		return int64(value), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil || parsed != math.Trunc(parsed) {
			return 0, false
		}
		if parsed > math.MaxInt64 || parsed < math.MinInt64 {
			return 0, false
		}
		return int64(parsed), true
	}
	return 0, false
}

// unbindableJSON 判断 route.ts 把原始 JSON 值交给 drizzle → better-sqlite3 时，
// 是否会在参数绑定阶段抛错。驱动只接受 number/string/bigint/buffer/null：
// 布尔是 TypeError，数组/对象是 RangeError（对象还会被当成命名参数），
// 全部落进 route.ts 的 catch → 500。这些形态不在冻结消费者的输入集里，
// 但状态码仍按 route.ts 对齐。
func unbindableJSON(v any) bool {
	switch v.(type) {
	case bool, []any, map[string]any:
		return true
	}
	return false
}

// asString 取字符串字段；非字符串返回 false（JS 的 typeof 判断）。
func asString(v any) (string, bool) {
	value, ok := v.(string)
	return value, ok
}

// parseIntBase10 复刻 `parseInt(value, 10)`：语义唯一实现见 jsparse.ParseInt10，
// 这里保留包内别名只是为了不把 jsparse 的调用散到每个 handler。
func parseIntBase10(value string) (int64, bool) { return jsparse.ParseInt10(value) }
