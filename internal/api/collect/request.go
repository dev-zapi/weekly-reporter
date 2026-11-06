package collect

import (
	"math"
	"strconv"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
)

// 本文件是两条 POST 路由共用的 JS 值语义辅助（`body?.sourceId`、`Number(value)`、
// `String(value)`），只镜像 route.ts 用到的可观测转换。请求体解析在 jsjson，
// `Number(string)` 文法在 jsparse，两者都是跨域共享的。

// objectBody 把 body 折成字段视图：`body?.sourceId` 对标量/数组得到 undefined
// （JS 的属性访问会把原始值装箱），只有 null/undefined 是 undefined。
func objectBody(body any) map[string]any {
	if object, ok := body.(map[string]any); ok {
		return object
	}
	return map[string]any{}
}

// truthyJSON 复刻 JS 的真值判断（`if (sourceId)`、`resync ? ... : ...`）。
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

// jsToNumberValue 复刻 `Number(value)`：ok=false 对应 NaN。
// 覆盖 JSON.parse 能产出的全部值类型。
func jsToNumberValue(v any) (float64, bool) {
	switch value := v.(type) {
	case nil:
		return 0, true // Number(null) === 0
	case bool:
		if value {
			return 1, true
		}
		return 0, true
	case float64:
		return value, true
	case string:
		return jsparse.ParseNumber(value)
	case []any:
		// ToPrimitive(array) → Array.prototype.toString → join(',')
		return jsparse.ParseNumber(jsArrayString(value))
	default:
		// 普通对象 → "[object Object]" → NaN
		return 0, false
	}
}

// jsArrayString 复刻 Array.prototype.toString：null/undefined 元素输出空串，
// 其余元素递归 ToString，再以逗号连接。
func jsArrayString(values []any) string {
	parts := make([]string, len(values))
	for i, value := range values {
		if value == nil {
			parts[i] = ""
			continue
		}
		parts[i] = jsToString(value)
	}
	return strings.Join(parts, ",")
}

// jsToString 复刻 `String(value)`，供 parseInt 的 ToString 前置步骤使用。
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
		return jsNumberToString(value)
	case string:
		return value
	case []any:
		return jsArrayString(value)
	default:
		return "[object Object]"
	}
}

// jsNumberToString 复刻 Number::toString 在 parseInt 场景下可观测的部分：
// 整数在 |v| < 1e21 时输出完整十进制，1e21 起用指数形式；非整数用最短往返表示。
// 指数位格式（`1e-07` vs `1e-7`）不影响 parseInt 的结果，因为遇到 `e` 就停。
func jsNumberToString(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	case v == 0:
		return "0"
	}

	abs := math.Abs(v)
	if v == math.Trunc(v) && abs < 1e21 {
		return strconv.FormatFloat(v, 'f', 0, 64)
	}
	if abs >= 1e21 || abs < 1e-6 {
		return strconv.FormatFloat(v, 'e', -1, 64)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}
