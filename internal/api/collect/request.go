package collect

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件是两条 POST 路由共用的请求体读取与 JS 值语义辅助。
// 与 plans/request.go 同一思路：只镜像 route.ts 用到的可观测转换。

// decodeJSON 复刻 `await request.json()`：读整个 body 再解析。
// 解析失败（含尾随垃圾）与 route.ts 一样抛错，由各 handler 的 catch 分支处理。
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
		return jsStringToNumber(value)
	case []any:
		// ToPrimitive(array) → Array.prototype.toString → join(',')
		return jsStringToNumber(jsArrayString(value))
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

// jsStringToNumber 复刻 ECMAScript 的 ToNumber(字符串)：裁掉首尾空白、空串为 0、
// 支持 ±Infinity 与 0x/0o/0b 字面量、十进制与指数写法；其余为 NaN。
// 与 auth 域 jsToNumber 同一套文法，这里只需要「成功/NaN」两态。
func jsStringToNumber(s string) (float64, bool) {
	s = jsstr.Trim(s)
	switch s {
	case "":
		return 0, true
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	}

	for _, prefix := range []struct {
		token string
		base  float64
	}{
		{"0x", 16}, {"0X", 16},
		{"0o", 8}, {"0O", 8},
		{"0b", 2}, {"0B", 2},
	} {
		if !strings.HasPrefix(s, prefix.token) {
			continue
		}
		// JS 不允许带符号的进制前缀（Number("-0x10") 是 NaN）。
		digits := s[len(prefix.token):]
		if digits == "" {
			return 0, false
		}
		var n float64
		for i := 0; i < len(digits); i++ {
			d, ok := radixDigit(prefix.base, digits[i])
			if !ok {
				return 0, false
			}
			n = n*prefix.base + d
		}
		return n, true
	}

	if !isJSDecimal(s) {
		return 0, false
	}
	number, err := strconv.ParseFloat(s, 64)
	if err != nil {
		// 上溢到 ±Inf、下溢到 0 都与 JS 一致；其它错误按 NaN 处理。
		if errors.Is(err, strconv.ErrRange) {
			return number, true
		}
		return 0, false
	}
	return number, true
}

// isJSDecimal 判断是否符合 JS 的十进制数字文法：
//
//	[+-]? ( digits [ '.' digits? ] | '.' digits ) [ ('e'|'E') [+-]? digits ]
func isJSDecimal(s string) bool {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	intDigits := 0
	for i < len(s) && isASCIIDigit(s[i]) {
		i++
		intDigits++
	}
	fracDigits := 0
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && isASCIIDigit(s[i]) {
			i++
			fracDigits++
		}
	}
	if intDigits == 0 && fracDigits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		expDigits := 0
		for i < len(s) && isASCIIDigit(s[i]) {
			i++
			expDigits++
		}
		if expDigits == 0 {
			return false
		}
	}
	return i == len(s)
}

func isASCIIDigit(b byte) bool { return b >= '0' && b <= '9' }

func radixDigit(base float64, b byte) (float64, bool) {
	switch {
	case b >= '0' && b <= '9':
		return float64(b - '0'), true
	case base == 16 && b >= 'a' && b <= 'f':
		return float64(b-'a') + 10, true
	case base == 16 && b >= 'A' && b <= 'F':
		return float64(b-'A') + 10, true
	}
	return 0, false
}
