package sources

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// 本文件复刻 route.ts 依赖的几个 JavaScript 值语义，与 B1/B2 的 jsparse/jsstr
// 同一思路：只镜像可观测行为，不引入新行为。

// decodeJSONBody 复刻 `await request.json()`：读整个 body 再解析。
// 解析失败与 TS 一样是错误（落进各 handler 的 catch）。
// json.Unmarshal 与 JSON.parse 一样拒绝尾随垃圾，且数字折成 float64。
func decodeJSONBody(r *http.Request) (any, error) {
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

// jsTruthy 复刻 JS 的真值判断（`if (name)`、`Boolean(body.enabled)`）。
func jsTruthy(v any) bool {
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

// isInOperatorOperand 复刻 JS 的 `'key' in value` 对操作数的要求：只有对象
// （含数组）可用；null 与标量都会抛 TypeError。
func isInOperatorOperand(value any) bool {
	switch value.(type) {
	case map[string]any, []any:
		return true
	}
	return false
}

// jsObject 把 JSON 对象折成 map。非对象（数组/标量）返回 false；null 也是 false。
func jsObject(v any) (map[string]any, bool) {
	object, ok := v.(map[string]any)
	return object, ok
}

// spreadObject 复刻 JS 的对象展开 `{...value}`：对象逐键复制、数组按数字索引、
// 其余标量不产生自有键。键值只有 zod 已知的字段有意义，数字索引键会被 zod
// 当作未知键剥掉，所以这里不做顺序保证。
func spreadObject(v any) map[string]any {
	switch value := v.(type) {
	case map[string]any:
		copied := make(map[string]any, len(value))
		for key, item := range value {
			copied[key] = item
		}
		return copied
	case []any:
		copied := make(map[string]any, len(value))
		for i, item := range value {
			copied[strconv.Itoa(i)] = item
		}
		return copied
	case string:
		// 字符串展开按码点产生索引键（JS 的可迭代展开）。
		runes := []rune(value)
		copied := make(map[string]any, len(runes))
		for i, r := range runes {
			copied[strconv.Itoa(i)] = string(r)
		}
		return copied
	}
	return map[string]any{}
}

// parseJSIntDouble 复刻 `parseInt(string)` 的数值结果（double）。ok=false 表示
// NaN。radix 为 0 时识别 0x 前缀；溢出不截断，按 JS 的 double 结果返回。
func parseJSIntDouble(raw string) (float64, bool) {
	i := 0
	for i < len(raw) && isJSWhitespace(raw[i]) {
		i++
	}
	negative := false
	if i < len(raw) && (raw[i] == '+' || raw[i] == '-') {
		negative = raw[i] == '-'
		i++
	}

	radix := 10
	if i+1 < len(raw) && raw[i] == '0' && (raw[i+1] == 'x' || raw[i+1] == 'X') {
		radix = 16
		i += 2
	}

	value := 0.0
	digits := 0
	for i < len(raw) {
		digit, ok := parseIntDigit(raw[i], radix)
		if !ok {
			break
		}
		value = value*float64(radix) + float64(digit)
		digits++
		i++
	}
	if digits == 0 {
		return math.NaN(), false
	}
	if negative {
		return -value, true
	}
	return value, true
}

func isJSWhitespace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}

func parseIntDigit(b byte, radix int) (int, bool) {
	switch {
	case b >= '0' && b <= '9':
		d := int(b - '0')
		if d < radix {
			return d, true
		}
	case radix == 16 && b >= 'a' && b <= 'f':
		return int(b-'a') + 10, true
	case radix == 16 && b >= 'A' && b <= 'F':
		return int(b-'A') + 10, true
	}
	return 0, false
}

// jsUndefined 表示「键不存在」。JSON 本身没有 undefined，但 zod 的缺失字段
// issue 会把它印成 received undefined，所以要有一个与 null 区分的哨兵。
type jsUndefinedType struct{}

var jsUndefined = jsUndefinedType{}

// jsonTypeName 复刻 zod 的 parsedType：JSON 世界里只可能出现这几种。
func jsonTypeName(value any) string {
	switch value.(type) {
	case jsUndefinedType:
		return "undefined"
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// numberFromQuery 复刻 `Number(searchParams.get(x) || ”)` 并报告是否为整数。
// 只用于 branches / emails 的 sourceId：Number(”) === 0、Number('7.5') 非整数、
// Number('abc') 是 NaN。十六进制/二进制/八进制前缀与 Infinity 与 JS 一致。
func numberFromQuery(raw string) (float64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, true
	}
	// Number('Infinity') 大小写敏感；带符号的进制前缀（'-0x10'）是 NaN。
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	}
	for _, prefix := range []struct {
		prefix string
		base   int
	}{{"0x", 16}, {"0X", 16}, {"0b", 2}, {"0B", 2}, {"0o", 8}, {"0O", 8}} {
		if strings.HasPrefix(trimmed, prefix.prefix) {
			n, err := strconv.ParseUint(trimmed[2:], prefix.base, 64)
			if err != nil {
				return 0, false
			}
			return float64(n), true
		}
	}
	n, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// jsString 复刻 `String(value)`，用于把 JSON 值拼进 URL 查询参数。
func jsString(v any) string {
	switch value := v.(type) {
	case nil:
		return "null"
	case bool:
		if value {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(value)
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if item == nil {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, jsString(item))
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsNumberString 复刻 JS 的 Number#toString（只覆盖查询参数里会遇到的形态）。
func jsNumberString(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == math.Trunc(value) && math.Abs(value) < 1e21:
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// jsSortStrings 复刻 `Array.prototype.sort()` 的默认比较：按 UTF-16 码元升序。
func jsSortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && jsStringLess(values[j], values[j-1]); j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func jsStringLess(a, b string) bool {
	ar := []rune(a)
	br := []rune(b)
	for i := 0; i < len(ar) && i < len(br); i++ {
		au := utf16Units(ar[i])
		bu := utf16Units(br[i])
		for k := 0; k < len(au) && k < len(bu); k++ {
			if au[k] != bu[k] {
				return au[k] < bu[k]
			}
		}
		if len(au) != len(bu) {
			return len(au) < len(bu)
		}
	}
	return len(ar) < len(br)
}

func utf16Units(r rune) []uint16 {
	if r < 0x10000 {
		return []uint16{uint16(r)}
	}
	r -= 0x10000
	return []uint16{uint16(0xd800 + (r >> 10)), uint16(0xdc00 + (r & 0x3ff))}
}
