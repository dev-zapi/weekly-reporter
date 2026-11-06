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
