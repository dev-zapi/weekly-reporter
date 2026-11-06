package tags

import (
	"unicode"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 src/lib/tags/parse.ts 的三个函数。它们是 ADR-0012 双存储里
// 「文本那一半」的唯一维护逻辑：解析出 tag、按同一套词边界删除 / 改名，
// 保证内容与 event_tags 关联表不漂移。
//
// 正则里用到的 `\s` 一律按 jsstr.IsSpace（ECMAScript 空白集合）判定。

// tagCharsetRune 判定正则里的 [\p{Script=Han}A-Za-z0-9]。
func tagCharsetRune(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || isHan(r)
}

// tagBodyRune 判定 `[\p{Script=Han}A-Za-z]`（tag 至少含一个才算合法）。
func tagBodyRune(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || unicode.Is(unicode.Han, r)
}

// ParseTags 复刻 parseTags：按词边界提取 `#tag`，去重并保持出现顺序。
//
// 边界规则与 TAG_MATCH_REGEX 一致：`#` 前是串首或一个空白，tag 之后是空白或串尾；
// tag 至少含一个汉字或字母（纯数字不算）。
func ParseTags(content string) []string {
	runes := []rune(content)
	seen := make(map[string]struct{})
	tags := []string{}

	for i := 0; i < len(runes); i++ {
		if runes[i] != '#' {
			continue
		}
		if i > 0 && !jsstr.IsSpace(runes[i-1]) {
			continue
		}
		start := i + 1
		end := start
		for end < len(runes) && tagCharsetRune(runes[end]) {
			end++
		}
		if end == start {
			continue
		}
		// 词尾边界：tag 之后必须是空白或串尾。
		if end < len(runes) && !jsstr.IsSpace(runes[end]) {
			continue
		}
		body := runes[start:end]
		hasLetter := false
		for _, r := range body {
			if tagBodyRune(r) {
				hasLetter = true
				break
			}
		}
		if !hasLetter {
			continue
		}
		tag := string(body)
		if _, dup := seen[tag]; dup {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	return tags
}

// RemoveTagFromContent 复刻 removeTagFromContent：删除内容里所有该 tag。
//
// 逐字移植的两个怪癖：
//   - 匹配包含 tag 前面的整段空白（`(^|\s+)` 贪婪），删除后把「删除位」归一成
//     单个空格；删除位在串首/串尾时归一成空串；
//   - 从后往前处理，且「吃掉尾部空白」的扫描作用在**已修改**的结果上（TS 就是
//     这么写的）。倒序处理保证每个匹配点之前的偏移仍然有效。
func RemoveTagFromContent(content, tagName string) string {
	runes := []rune(content)
	matches := matchTagSites(runes, tagName)
	if len(matches) == 0 {
		return content
	}

	result := runes
	for i := len(matches) - 1; i >= 0; i-- {
		start, end := matches[i][0], matches[i][1]

		// 正则的尾部 lookahead 不消费空白，这里手动吃掉。
		siteEnd := end
		for siteEnd < len(result) && jsstr.IsSpace(result[siteEnd]) {
			siteEnd++
		}

		replacement := []rune(" ")
		if start == 0 || siteEnd >= len(result) {
			replacement = nil
		}

		next := make([]rune, 0, start+len(replacement)+len(result)-siteEnd)
		next = append(next, result[:start]...)
		next = append(next, replacement...)
		next = append(next, result[siteEnd:]...)
		result = next
	}

	return jsstr.Trim(string(result))
}

// RenameTagInContent 复刻 renameTagInContent：按词边界把 `#old` 改成 `#new`，
// 前导空白原样保留（正则捕获组 1 回填）。
func RenameTagInContent(content, oldName, newName string) string {
	runes := []rune(content)
	matches := matchTagSites(runes, oldName)
	if len(matches) == 0 {
		return content
	}

	nameLen := len([]rune(oldName))
	var out []rune
	pos := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		out = append(out, runes[pos:start]...)
		// runes[start:end-nameLen] 是「前导空白 + '#'」，捕获组 1 与字面量 '#' 回填。
		out = append(out, runes[start:end-nameLen]...)
		out = append(out, []rune(newName)...)
		pos = end
	}
	out = append(out, runes[pos:]...)
	return string(out)
}

// matchTagSites 返回 `(^|\s+)(#name)(?=\s|$)` 的全部匹配区间（runes 下标，[start,end)）。
// 区间包含 tag 前面的整段空白：`\s+` 贪婪，且删除/改名都要把这段空白算进去。
func matchTagSites(runes []rune, tagName string) [][2]int {
	name := []rune("#" + tagName)
	if tagName == "" {
		return nil
	}

	var matches [][2]int
	i := 0
	for i < len(runes) {
		// 前导边界：串首（零宽）或从这里开始的一段空白。
		// 串首是空白时，`^` 分支匹配不到 '#'，正则回溯到 `\s+` 分支，
		// 所以统一下成「从 start 跳过整段空白」即可。
		if i > 0 && !jsstr.IsSpace(runes[i]) {
			i++
			continue
		}
		hashIdx := i
		for hashIdx < len(runes) && jsstr.IsSpace(runes[hashIdx]) {
			hashIdx++
		}

		end := hashIdx + len(name)
		if end <= len(runes) && string(runes[hashIdx:end]) == string(name) {
			if end >= len(runes) || jsstr.IsSpace(runes[end]) {
				matches = append(matches, [2]int{i, end})
				i = end
				continue
			}
		}
		i++
	}
	return matches
}
