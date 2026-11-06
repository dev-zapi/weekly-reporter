// Package jsparse 复刻冻结合同里依赖的几个 JavaScript 内建语义。
//
// 为什么需要它：B1 的两条路由（`DELETE /api/auth/pats/{id}` 与 `GET /api/audit`）
// 都用 `parseInt` 解析路径 / 查询参数，而 `parseInt` 与 Go 的 strconv.Atoi 在边界
// 上不同：它容忍数字后的垃圾（`parseInt('12abc') === 12`）、跳过前导空白、接受
// `0x` 前缀，且「没有数字」返回 NaN 而不是错误。直接 Atoi 会把这些请求判成 400，
// 偏离蓝图 §2.1 冻结的状态码与响应形状。
package jsparse

import (
	"errors"
	"math"
	"strconv"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// ParseInt 复刻 JavaScript `parseInt(value)`（不传 radix）的语义。
// ok=false 对应 JS 的 NaN。
//
// 溢出（例如 20 位数字）在 JS 里是有限浮点数、查库必然查不到，这里饱和到
// MaxInt64，最终落到与 TS 相同的 404 / 空列表 / 默认值分支，不引入额外分支。
func ParseInt(value string) (int64, bool) {
	n, ok, _ := parseIntRadix(value, 0)
	return n, ok
}

// ParseInt10 复刻 JavaScript `parseInt(value, 10)`：radix 固定十进制，所以不识别
// `0x` 前缀（"0x10" 解析为 0，'0' 之后遇到 'x' 就停）。route.ts 里的
// `parseInt(id, 10)` 全是这种形态，snippets 与 plans 域共用这一份。
func ParseInt10(value string) (int64, bool) {
	n, ok, _ := parseIntRadix(value, 10)
	return n, ok
}

// ParseIntWithOverflow 在 ParseInt 之上多报一个信号：JS 的 double 结果已到 2^63。
//
// parseInt 先把精确整数舍入到 double，数学值 ≥ 2^63-512 时结果就是 2^63。route.ts
// 把这个数绑进 SQLite 的 LIMIT/OFFSET 会 datatype mismatch（drizzle 按 REAL 绑定），
// 整条查询报错 → 500 FETCH_ERROR。只饱和到 MaxInt64 会让这一档静默变成「空列表
// 200」，与冻结状态码不符，所以调用方需要这个区分。
func ParseIntWithOverflow(value string) (n int64, ok, overflow bool) {
	return parseIntRadix(value, 0)
}

// parseIntRadix 是上面三个入口的共同实现；fixedRadix=0 表示「按 `0x` 前缀推断」。
func parseIntRadix(value string, fixedRadix int64) (n int64, ok, overflow bool) {
	i := 0
	// parseInt 会跳过前导空白。
	for i < len(value) && isJSSpace(value[i]) {
		i++
	}

	negative := false
	if i < len(value) && (value[i] == '+' || value[i] == '-') {
		negative = value[i] == '-'
		i++
	}

	radix := fixedRadix
	if radix == 0 {
		radix = 10
		if i+1 < len(value) && value[i] == '0' && (value[i+1] == 'x' || value[i+1] == 'X') {
			radix = 16
			i += 2
		}
	}

	var magnitude int64
	digits := 0
	for i < len(value) {
		d, ok := digitValue(value[i], radix)
		if !ok {
			break
		}
		if magnitude > (math.MaxInt64-int64(d))/radix {
			magnitude = math.MaxInt64
		} else {
			magnitude = magnitude*radix + int64(d)
		}
		digits++
		i++
	}
	if digits == 0 {
		return 0, false, false
	}
	// [2^62, 2^63) 区间 double 的间距是 1024，2^63-512 舍入到 2^63。
	const doubleOverflowThreshold = math.MaxInt64 - 511 // = 2^63 - 512
	overflow = magnitude >= doubleOverflowThreshold
	if negative {
		return -magnitude, true, overflow
	}
	return magnitude, true, overflow
}

// isJSSpace 覆盖 JS 会跳过的 ASCII 空白。非 ASCII 空白（如 U+00A0）在路径 / 查询
// 参数里等价于「没有数字」，落到同一个 NaN 分支，不必镜像完整的 ECMAScript 空白表。
func isJSSpace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}

func digitValue(b byte, radix int64) (int, bool) {
	switch {
	case b >= '0' && b <= '9':
		d := int(b - '0')
		if int64(d) < radix {
			return d, true
		}
	case radix == 16 && b >= 'a' && b <= 'f':
		return int(b-'a') + 10, true
	case radix == 16 && b >= 'A' && b <= 'F':
		return int(b-'A') + 10, true
	}
	return 0, false
}

// ParseNumber 复刻 `Number(string)`（ECMAScript ToNumber 的字符串分支）：
// 裁掉 JS 的首尾空白、空串为 0、支持 ±Infinity 与 0x/0o/0b 字面量、十进制与
// 指数写法；其余为 NaN（ok=false）。
//
// 不能直接用 strconv.ParseFloat 兜底：Go 还接受 "inf" / "nan" / 十六进制浮点
// 这类 JS 视为 NaN 的写法，也会接受 Go 的下划线分隔数字。先按 JS 文法校验再解析。
func ParseNumber(value string) (float64, bool) {
	s := jsstr.Trim(value)
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
