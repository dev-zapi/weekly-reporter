package events

import (
	"bytes"
	"encoding/json"
	"math"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/tags"
)

// 本文件移植 src/lib/references/parse.ts、src/lib/plan-references/parse.ts 里
// events 路由用到的引用解析。三者共用同一套词边界规则（前面是串首或空白，
// 后面是空白或串尾、且不消费）。

// ParseReferences 复刻 parseReferences：提取 `@<id>`，按出现顺序去重，
// 只保留 > 0 的有限整数。
func ParseReferences(content string) []int64 {
	return parseIDReferences(content, '@')
}

// ParsePlanReferences 复刻 parsePlanReferences：提取 `%<id>`。
func ParsePlanReferences(content string) []int64 {
	return parseIDReferences(content, '%')
}

// parseIDReferences 实现 `(?:^|\s)[@%](\d+)(?=\s|$)` 的提取。
//
// 与标签不同，id 段只认 ASCII 数字（JS 的 \d 默认就是 [0-9]）；Number.parseInt
// 之后再判 `isFinite && > 0`，所以 "0" 被丢弃。
func parseIDReferences(content string, marker rune) []int64 {
	runes := []rune(content)
	seen := make(map[int64]struct{})
	ids := []int64{}

	for i := 0; i < len(runes); i++ {
		if runes[i] != marker {
			continue
		}
		if i > 0 && !jsstr.IsSpace(runes[i-1]) {
			continue
		}
		start := i + 1
		end := start
		for end < len(runes) && runes[end] >= '0' && runes[end] <= '9' {
			end++
		}
		if end == start {
			continue
		}
		if end < len(runes) && !jsstr.IsSpace(runes[end]) {
			continue
		}
		id := parseDigits(runes[start:end])
		if id <= 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

// parseDigits 把纯数字段解析成 int64；溢出饱和到 MaxInt64（JS 那边是 1e20 这类
// 有限浮点数，查库必然查不到，可观测结果与饱和一致）。
func parseDigits(digits []rune) int64 {
	var n int64
	for _, r := range digits {
		d := int64(r - '0')
		if n > (math.MaxInt64-d)/10 {
			return math.MaxInt64
		}
		n = n*10 + d
	}
	return n
}

// parseTags 直接用标签域的实现：双存储的文本规则只有一份事实源。
func parseTags(content string) []string { return tags.ParseTags(content) }

// isJSONObject 判断原始 JSON 值是否是对象字面量（`{...}`）。
func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}
