// Package jsnum 复刻冻结合同里依赖的两个 JavaScript 数值语义：
//
//   - `String(number)`（ECMAScript 的 Number::toString，radix 10）；
//   - `parseFloat(string)`。
//
// 两者都不是简单套 strconv 能对等的：`String(number)` 的输出是 ECMAScript 的
// Number::toString（1e-7 而不是 Go 的 1e-07，0.00001 而不是 1e-05），
// `parseFloat` 只吃数字前缀（"0.3abc" → 0.3），与 `Number()` 的整串文法不同。
//
// 与 internal/api/jsstr、jsdate、jsjson、jsparse 同一思路：跨域共用的 JS 语义只
// 有一份实现。B5 的 prompts 域（写读 ai_styles.temperature 列）与 ai 域（拼接
// expand-section 的提示词、unify-style 的 message 文案）都消费这里的语义；
// B6 起 internal/engine 的循环与持久化副作用也消费本包（temperature/预算换算）。
package jsnum

import (
	"math"
	"strconv"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// FormatNumber 复刻 ECMAScript 的 Number::toString（radix 10）。
func FormatNumber(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == 0:
		// -0 也输出 "0"。
		return "0"
	}

	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}

	// strconv 的 'e' 形式给出最短往返的数字串与十进制指数。
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(formatted, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exponent, _ := strconv.Atoi(exponentText)

	// ECMAScript 的规则以 k（有效数字个数）与 n（小数点位置）表达。
	k := len(digits)
	n := exponent + 1

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		exponentSign := "+"
		if e < 0 {
			exponentSign = "-"
			e = -e
		}
		if k == 1 {
			return sign + digits + "e" + exponentSign + strconv.Itoa(e)
		}
		return sign + digits[:1] + "." + digits[1:] + "e" + exponentSign + strconv.Itoa(e)
	}
}

// ParseFloat 复刻 `parseFloat(value)`：跳过前导空白，取最长的数字前缀；
// 没有数字前缀（含空串）得到 NaN（ok=false）。
//
// 与 `Number(value)` 的差别：整串不必合法（"0.3abc" → 0.3），空串是 NaN 而不是
// 0，十六进制前缀只解析出开头的 0。
func ParseFloat(value string) (float64, bool) {
	s := strings.TrimLeftFunc(value, jsstr.IsSpace)
	p := parseFloatPrefix(s)
	if p == "" {
		return 0, false
	}
	number, err := strconv.ParseFloat(p, 64)
	if err != nil {
		// 溢出（"1e999"）在 JS 里是 Infinity，strconv 仍返回该值。
		if strings.Contains(err.Error(), "range") {
			return number, true
		}
		return 0, false
	}
	return number, true
}

// parseFloatPrefix 返回 parseFloat 会消费的最长前缀。文法与 ECMAScript 的
// StrDecimalLiteral 相同：`[+-]?Infinity` 或
// `[+-]?(digits[.digits?] | .digits)[(e|E)[+-]?digits]?`（指数部分只有在完整
// 时才计入，否则回退到它之前的位置）。
func parseFloatPrefix(s string) string {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	rest := s[i:]
	if strings.HasPrefix(rest, "Infinity") {
		return s[:i+len("Infinity")]
	}

	start := 0
	digits := 0
	for i < len(s) && isDigit(s[i]) {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && isDigit(s[i]) {
			i++
			digits++
		}
	}
	if digits == 0 {
		return ""
	}
	end := i

	// 指数部分必须完整（有数字），否则不消费它。
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		j := i + 1
		if j < len(s) && (s[j] == '+' || s[j] == '-') {
			j++
		}
		expDigits := 0
		for j < len(s) && isDigit(s[j]) {
			j++
			expDigits++
		}
		if expDigits > 0 {
			end = j
		}
	}

	return s[start:end]
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }
