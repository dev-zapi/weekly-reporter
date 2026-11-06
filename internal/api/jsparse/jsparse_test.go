package jsparse

import (
	"math"
	"testing"
)

// 这些向量直接从 Node 的 parseInt 行为抄来（`node -e "console.log(parseInt(...))"`），
// 枚举的是 B1 两条路由真正会遇到的输入形态：路径 id 与 audit 的 limit/offset/status。
func TestParseIntMatchesJavaScript(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"12", 12, true},
		{"0", 0, true},
		{"12abc", 12, true}, // parseInt 在第一个非数字处停下
		{" 12 ", 12, true},  // 跳过前导空白，尾部垃圾忽略
		{"\t\n12", 12, true},
		{"+7", 7, true},
		{"-7", -7, true},
		{"1e3", 1, true}, // 不是浮点解析：'e' 截断
		{"12.9", 12, true},
		{"0x10", 16, true}, // 无 radix 时 0x 前缀切十六进制
		{"-0x10", -16, true},
		{"abc", 0, false},
		{"", 0, false},
		{"   ", 0, false},
		{"+", 0, false},
		{"-", 0, false},
		{"0x", 0, false}, // 前缀后没有十六进制数字 = NaN
	}

	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := ParseInt(tc.in)
			if ok != tc.ok {
				t.Fatalf("ParseInt(%q) ok = %t, want %t", tc.in, ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("ParseInt(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// parseInt(value, 10) 与不传 radix 的唯一可观测差别是 0x 前缀：radix 固定十进制时
// '0' 之后遇到 'x' 就停，所以 "0x10" 是 0 而不是 16。这是 snippets 与 plans 域
// 路径 id 解析的实际形态。
func TestParseInt10FixesRadixToDecimal(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"12", 12, true},
		{" 12abc", 12, true},
		{"-7", -7, true},
		{"0x10", 0, true},
		{"-0x10", 0, true},
		{"12.9", 12, true},
		{"abc", 0, false},
		{"", 0, false},
		{"+", 0, false},
		{"0x", 0, true}, // 十进制下 '0' 就是一位数字，'x' 截断
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := ParseInt10(tc.in)
			if ok != tc.ok {
				t.Fatalf("ParseInt10(%q) ok = %t, want %t", tc.in, ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("ParseInt10(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// 溢出饱和：JS 会把超大数字解析成有限浮点（查库必然查不到），Go 饱和到 MaxInt64
// 后同样落到 404 / 空列表，不 panic、不返回 NaN。
func TestParseIntSaturatesOnOverflow(t *testing.T) {
	got, ok := ParseInt("99999999999999999999999999")
	if !ok {
		t.Fatalf("ok = false, want true (JS returns a finite number)")
	}
	if got != math.MaxInt64 {
		t.Fatalf("got = %d, want MaxInt64", got)
	}
}

// double 舍入边界：数学值 ≥ 2^63-512 时 parseInt 的结果是 2^63，绑进 SQLite 的
// LIMIT/OFFSET 会 datatype mismatch（route.ts 因此回 500）。阈值两侧各取一例。
func TestParseIntWithOverflowFlagsDoubleRounding(t *testing.T) {
	cases := []struct {
		in       string
		want     int64
		overflow bool
	}{
		{"9223372036854775295", 9223372036854775295, false}, // 2^63-513，舍入到 2^63-1024
		{"9223372036854775296", 9223372036854775296, true},  // 2^63-512，舍入到 2^63
		{"9223372036854775807", math.MaxInt64, true},
		{"9223372036854775808", math.MaxInt64, true},
		{"99999999999999999999", math.MaxInt64, true},
		{"1", 1, false},
		{"-9223372036854775807", -math.MaxInt64, true},
		{"-1", -1, false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok, overflow := ParseIntWithOverflow(tc.in)
			if !ok {
				t.Fatalf("ok = false, want true")
			}
			if got != tc.want {
				t.Fatalf("got = %d, want %d", got, tc.want)
			}
			if overflow != tc.overflow {
				t.Fatalf("overflow = %t, want %t", overflow, tc.overflow)
			}
		})
	}
}

// ParseNumber 复刻 Number(string)。期望值来自 Node 实测；重点是 Go 的
// strconv.ParseFloat 会接受而 JS 视为 NaN 的写法（"inf"、"nan"、"1_0"）必须被
// 文法校验拦住。
func TestParseNumberMatchesJavaScript(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"7", 7, true},
		{"", 0, true},
		{"   ", 0, true},
		{" 3 ", 3, true},
		{"-7.5", -7.5, true},
		{".5", 0.5, true},
		{"1e3", 1000, true},
		{"0x10", 16, true},
		{"0b101", 5, true},
		{"0o17", 15, true},
		{"Infinity", math.Inf(1), true},
		{"+Infinity", math.Inf(1), true},
		{"-Infinity", math.Inf(-1), true},
		{"abc", 0, false},
		{"0x", 0, false},
		{"-0x10", 0, false}, // JS 不允许带符号的进制前缀
		{"1_0", 0, false},   // Go 的下划线分隔符不是 JS 文法
		{"inf", 0, false},   // Go 接受、JS 是 NaN
		{"nan", 0, false},
		{"1.", 1, true},
		{"1e", 0, false},
		// JS 的 trim 集合：U+FEFF 是空白、U+0085 不是（Go 的 TrimSpace 恰好相反）。
		{"\ufeff7", 7, true},
		{"\u00857", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := ParseNumber(tc.in)
			if ok != tc.ok {
				t.Fatalf("ParseNumber(%q) ok = %t, want %t", tc.in, ok, tc.ok)
			}
			if !ok {
				return
			}
			if got != tc.want && !(math.IsInf(tc.want, 0) && math.IsInf(got, int(math.Copysign(1, tc.want)))) {
				t.Fatalf("ParseNumber(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
