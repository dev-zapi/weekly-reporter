package generation

import (
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/reports"
)

// 本文件移植 src/lib/generation/context.ts 的 buildSourceOverview：把确定性原稿
// 压成会话副本里的简短概览（仓库分组 + 前 5 条事件）。

// BuildSourceOverview 复刻 buildSourceOverview(sourceDraft, variant)。
func BuildSourceOverview(sourceDraft, variant string) string {
	lines := make([]string, 0)
	for _, line := range strings.Split(sourceDraft, "\n") {
		trimmed := strings.TrimRight(line, " ")
		if jsstr.Trim(trimmed) == "" {
			continue
		}
		lines = append(lines, line)
	}

	repositories := make([]string, 0)
	events := make([]string, 0)
	for _, line := range lines {
		if repo, ok := matchRepoLine(line); ok {
			repositories = append(repositories, repo)
			continue
		}
		if event, ok := matchEventLine(line); ok {
			if reports.IsEmptySourceDraft(event) {
				continue
			}
			events = append(events, stripBold(event))
		}
	}

	label := "个人版"
	if variant == "leadership" {
		label = "领导版"
	}
	if len(events) == 0 {
		return label + " source draft: No usable events this week."
	}

	preview := make([]string, 0, 5)
	limit := len(events)
	if limit > 5 {
		limit = 5
	}
	for index := 0; index < limit; index++ {
		compact := jsstr.Trim(collapseWhitespace(events[index]))
		display := compact
		if jsstr.UTF16Len(compact) > 88 {
			display = reports.SliceUTF16(compact, 88) + "…"
		}
		preview = append(preview, itoa(index+1)+". "+display)
	}

	repositorySummary := "No repository groups identified"
	if len(repositories) > 0 {
		repositorySummary = itoa(len(repositories)) + " repositories/projects: " + strings.Join(repositories, ", ")
	}
	remainder := ""
	if len(events) > len(preview) {
		remainder = "\n" + itoa(len(events)-len(preview)) + " more events omitted from the overview."
	}
	return label + " source draft: " + itoa(len(events)) + " events. " + repositorySummary + ".\n" +
		strings.Join(preview, "\n") + remainder
}

// matchRepoLine 复刻 /^\s*-\s+\*\*(.+?)\*\*\s*$/。
func matchRepoLine(line string) (string, bool) {
	rest := strings.TrimLeft(line, " ")
	rest = trimLeftJSWhitespace(rest)
	if !strings.HasPrefix(rest, "-") {
		return "", false
	}
	rest = rest[1:]
	trimmed := trimLeftJSWhitespace(rest)
	if len(trimmed) == len(rest) {
		return "", false
	}
	if !strings.HasPrefix(trimmed, "**") {
		return "", false
	}
	body := trimmed[2:]
	end := strings.Index(body, "**")
	if end <= 0 {
		return "", false
	}
	trailing := body[end+2:]
	if jsstr.Trim(trailing) != "" {
		return "", false
	}
	return body[:end], true
}

// matchEventLine 复刻 /^\s*-\s+(.+)$/。
func matchEventLine(line string) (string, bool) {
	rest := trimLeftJSWhitespace(line)
	if !strings.HasPrefix(rest, "-") {
		return "", false
	}
	rest = rest[1:]
	trimmed := trimLeftJSWhitespace(rest)
	if len(trimmed) == len(rest) || trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// stripBold 复刻 `event.replace(/^\*\*(.+?)\*\*$/, '$1')`。
func stripBold(value string) string {
	if len(value) < 5 || !strings.HasPrefix(value, "**") || !strings.HasSuffix(value, "**") {
		return value
	}
	inner := value[2 : len(value)-2]
	if strings.Contains(inner, "**") || inner == "" {
		return value
	}
	return inner
}

// collapseWhitespace 复刻 `event.replace(/\s+/g, ' ')`。
func collapseWhitespace(value string) string {
	var builder strings.Builder
	inWhitespace := false
	for _, r := range value {
		if jsstr.IsSpace(r) {
			if !inWhitespace {
				builder.WriteByte(' ')
			}
			inWhitespace = true
			continue
		}
		inWhitespace = false
		builder.WriteRune(r)
	}
	return builder.String()
}

func trimLeftJSWhitespace(value string) string {
	return strings.TrimLeftFunc(value, jsstr.IsSpace)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var buffer [20]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		buffer[index] = '-'
	}
	return string(buffer[index:])
}
