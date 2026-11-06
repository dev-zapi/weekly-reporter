// Package jsstr 复刻冻结合同里依赖的几个 JavaScript 字符串内建语义。
//
// 为什么需要它：B2 的标签解析、内容校验与 UTF-16 计长都以 `route.ts` / `parse.ts`
// 为唯一事实源，而 Go 的 len()/TrimSpace 与 JS 的 string.length/trim 在 Unicode
// 边界上不同（CJK 字节数 ≠ UTF-16 单元数；JS 的 \s 与 unicode.IsSpace 的集合也
// 不完全相同）。与 internal/api/jsparse 同一思路：只镜像可观测语义，不引入新行为。
package jsstr

import (
	"strings"
	"unicode/utf8"
)

// IsSpace 复刻 ECMAScript 的 \s（WhiteSpace + LineTerminator）：
// TAB/VT/FF/SP/NBSP/ZWNBSP、行终止符以及 Unicode 的 Zs 类空白。
// Go 的 unicode.IsSpace 多包含 U+0085、不含 U+FEFF，两者按此表对齐。
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Trim 复刻 String.prototype.trim()：去掉两端的 ECMAScript 空白。
func Trim(s string) string {
	start := 0
	for start < len(s) {
		r, size := utf8.DecodeRuneInString(s[start:])
		if !IsSpace(r) {
			break
		}
		start += size
	}
	end := len(s)
	for end > start {
		r, size := utf8.DecodeLastRuneInString(s[start:end])
		if !IsSpace(r) {
			break
		}
		end -= size
	}
	return s[start:end]
}

// UTF16Len 复刻 JS 的 string.length：UTF-16 码元数（BMP 字符 1，增补平面 2）。
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xffff {
			n += 2
			continue
		}
		n++
	}
	return n
}

// SliceUTF16 复刻 JS 的 String.prototype.slice(0, n)：按 UTF-16 码元截断。
//
// 与 JS 的一个有意边界差异：JS 允许把增补平面字符劈成孤立代理项（随后
// JSON.stringify 会输出 \udXXX 转义），Go 的 string 无法表示孤立代理项；
// 需要劈开时本函数整对舍弃（少 1 个码元），避免产生非法 UTF-8。
//
// 所有字符预算（450k 上下文、40k 正文、280 字 publicSummary、2k rawResponse、
// 200k proposal）都是 TS string.length 语义，必须在 Go 侧走这一份实现
// （ADR-0027；风险登记 #4 的 UTF-16 漂移）。
func SliceUTF16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	count := 0
	for index, r := range s {
		units := 1
		if r > 0xFFFF {
			units = 2
		}
		if count+units > n {
			return s[:index]
		}
		count += units
	}
	return s
}

// EncodeURIComponent 复刻 ECMAScript 的 encodeURIComponent：不转义的字符集是
// A-Za-z0-9 与 `-_.!~*'()`，其余按 UTF-8 字节 %XX。
//
// 与 url.QueryEscape 不同：后者把空格写成 '+'，保留字符集也不同。
func EncodeURIComponent(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	const hex = "0123456789ABCDEF"

	var builder strings.Builder
	for i := 0; i < len(value); i++ {
		b := value[i]
		if strings.IndexByte(unreserved, b) >= 0 {
			builder.WriteByte(b)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hex[b>>4])
		builder.WriteByte(hex[b&0x0f])
	}
	return builder.String()
}
