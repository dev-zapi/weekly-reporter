package sources

import (
	"math"
	"sort"
	"strconv"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
)

// 本文件复刻 route.ts 依赖的几个 JavaScript 值语义，与 B1/B2 的 jsparse/jsstr
// 同一思路：只镜像可观测行为，不引入新行为。
//
// 跨票重复的语义不再留私有拷贝：`await request.json()` 在 jsjson，
// `Number(string)` 的 ECMAScript 文法在 jsparse.ParseNumber。

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

// numberFromQuery 复刻 `Number(searchParams.get(x) || ”)`，第二个返回值是
// `Number.isInteger`。只用于 branches / emails 的 sourceId：Number(”) === 0、
// Number('7.5') 非整数、Number('abc') 是 NaN。文法由 jsparse.ParseNumber 提供。
func numberFromQuery(raw string) (float64, bool) {
	value, ok := jsparse.ParseNumber(raw)
	if !ok {
		return math.NaN(), false
	}
	return value, isInteger(value)
}

func isInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// jsSortStrings 复刻 `Array.prototype.sort()` 的默认比较：按 UTF-16 码元升序。
func jsSortStrings(values []string) {
	sort.SliceStable(values, func(i, j int) bool { return jsStringLess(values[i], values[j]) })
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
