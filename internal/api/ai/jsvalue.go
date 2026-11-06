package ai

import (
	"math"
	"strconv"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
)

// 本文件是三条 one-shot 路由共用的 JS 值语义辅助，只镜像 route.ts / src/lib/ai
// 实际用到的可观测转换。请求体解析统一走 internal/api/jsjson，数值语义（
// Number::toString / parseFloat）走 internal/api/jsnum。

// objectBody 把 body 折成字段视图：JS 里对 null/undefined 取属性会抛错，这一点
// 由调用方的 `body == nil` 判断覆盖；标量与数组没有已知字段，等价于空对象。
func objectBody(body any) map[string]any {
	if object, ok := body.(map[string]any); ok {
		return object
	}
	return map[string]any{}
}

// truthyJSON 复刻 JS 真值判断（`if (body.templateId)`、`if (body.styleOverride)`）。
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

// jsToString 复刻 `String(value)`。
func jsToString(v any) string {
	switch value := v.(type) {
	case nil:
		return "null"
	case bool:
		if value {
			return "true"
		}
		return "false"
	case float64:
		return jsnum.FormatNumber(value)
	case string:
		return value
	case []any:
		return jsJoin(value, ",")
	default:
		return "[object Object]"
	}
}

// jsJoin 复刻 Array.prototype.join：null/undefined 元素变成空串，其余经
// String() 转换（嵌套数组再按 ',' 拼）。
func jsJoin(values []any, separator string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		if value == nil {
			parts = append(parts, "")
			continue
		}
		parts = append(parts, jsToString(value))
	}
	return strings.Join(parts, separator)
}

// asID 复刻 drizzle 把 JSON 值绑进 integer 主键时的 SQLite 亲和性：整数数字按
// 数值、数字字符串按数值转换；非整数值不可能命中整数主键。
// 与 internal/api/plans 的同名逻辑一致。
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
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed != math.Trunc(parsed) {
			return 0, false
		}
		if parsed > math.MaxInt64 || parsed < math.MinInt64 {
			return 0, false
		}
		return int64(parsed), true
	}
	return 0, false
}

// unbindableJSON 判断把原始 JSON 值交给 better-sqlite3 绑定时是否会抛错。
// 驱动只接受 numbers / strings / bigints / buffers / null：布尔是 TypeError，
// 数组/对象是 RangeError，全部落进 route.ts 的 catch → 500。这些形态不在冻结
// 消费者的输入集里，但状态码仍按 route.ts 对齐。
func unbindableJSON(v any) bool {
	switch v.(type) {
	case bool, []any, map[string]any:
		return true
	}
	return false
}
