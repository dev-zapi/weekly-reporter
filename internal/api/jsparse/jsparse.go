// Package jsparse 复刻冻结合同里依赖的几个 JavaScript 内建语义。
//
// 为什么需要它：B1 的两条路由（`DELETE /api/auth/pats/{id}` 与 `GET /api/audit`）
// 都用 `parseInt` 解析路径 / 查询参数，而 `parseInt` 与 Go 的 strconv.Atoi 在边界
// 上不同：它容忍数字后的垃圾（`parseInt('12abc') === 12`）、跳过前导空白、接受
// `0x` 前缀，且「没有数字」返回 NaN 而不是错误。直接 Atoi 会把这些请求判成 400，
// 偏离蓝图 §2.1 冻结的状态码与响应形状。
package jsparse

import "math"

// ParseInt 复刻 JavaScript `parseInt(value)`（不传 radix）的语义。
// ok=false 对应 JS 的 NaN。
//
// 溢出（例如 20 位数字）在 JS 里是有限浮点数、查库必然查不到，这里饱和到
// MaxInt64，最终落到与 TS 相同的 404 / 空列表 / 默认值分支，不引入额外分支。
func ParseInt(value string) (int64, bool) {
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

	radix := int64(10)
	if i+1 < len(value) && value[i] == '0' && (value[i+1] == 'x' || value[i+1] == 'X') {
		radix = 16
		i += 2
	}

	var n int64
	digits := 0
	for i < len(value) {
		d, ok := digitValue(value[i], radix)
		if !ok {
			break
		}
		if n > (math.MaxInt64-int64(d))/radix {
			n = math.MaxInt64
		} else {
			n = n*radix + int64(d)
		}
		digits++
		i++
	}
	if digits == 0 {
		return 0, false
	}
	if negative {
		return -n, true
	}
	return n, true
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
