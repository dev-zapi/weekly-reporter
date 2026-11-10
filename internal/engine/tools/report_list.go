package tools

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/wiretime"
)

// 本文件移植 src/lib/generation/report-list-tool.ts（query_report_list）。
//
// 四个维度一个不少：cursor 分页、legacy 兼容路径、previous_adjacent、grep 预算
// （attachMatches 的 20,000 UTF-16 字符预算）。

const (
	// maxListMatchesPerReport 是每个列表项最多附带的正文命中段数（ts: slice(0, 3)）。
	maxListMatchesPerReport = 3
	// matchCharacterBudget 是跨全部列表项共享的命中正文预算（ts: 20_000）。
	matchCharacterBudget = 20_000
	// defaultListLimit / maxListLimit 是 limit 的默认值与上限。
	defaultListLimit = 10
	maxListLimit     = 20
	// maxTextFilterCharacters 是 query/title 的长度上限（UTF-16 单元）。
	maxTextFilterCharacters = 200
)

// isoDatePattern 对应 ts 的 /^\d{4}-\d{2}-\d{2}$/。JS 的 \d 是 ASCII 数字，
// Go 的 regexp \d 也是 ASCII，两者一致。
var isoDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// cleanDate 复刻 ts 的 cleanDate：先过 YYYY-MM-DD 形状，再过 date-fns 的
// parseISO + isValid + format 回写比对。
//
// 回写比对的实际效果 = 日历合法性（2027-02-31、2027-04-31 不合法）。date-fns
// 对 year 0000 会把年份格式化成 0001（JS Date 没有 year 0），因此 `0000-01-01`
// 回写不等于原串 → 非法；这里显式排除 year 0 保持一致。
func cleanDate(value string) bool {
	if !isoDatePattern.MatchString(value) {
		return false
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return false
	}
	return parsed.Year() != 0 && parsed.Format("2006-01-02") == value
}

// invalid 构造 INVALID_QUERY 失败结果。
func invalid(message string) ReportListToolResult {
	return ReportListToolResult{OK: false, Error: &ToolError{Code: ErrorCodeInvalidQuery, Message: message}}
}

func queryFailed(message string) ReportListToolResult {
	return ReportListToolResult{OK: false, Error: &ToolError{Code: ErrorCodeQueryFailed, Message: message}}
}

// cleanTextFilter 复刻 ts 的 cleanTextFilter：trim 后按 UTF-16 单元计长要求
// 1..200。返回 (nil, nil) 表示键缺失。
func cleanTextFilter(value *string, field string) (*string, *ReportListToolResult) {
	if value == nil {
		return nil, nil
	}
	normalized := jsstr.Trim(*value)
	if length := jsstr.UTF16Len(normalized); length < 1 || length > maxTextFilterCharacters {
		result := invalid(fmt.Sprintf("%s must contain 1 to 200 characters after trimming", field))
		return nil, &result
	}
	return &normalized, nil
}

// cleanDateFilter 复刻 ts 的 cleanDate(value, field)，但 wire 契约已切到
// RFC3339 带偏移（issue #135/#140）：合法参数复用 HTTP 搜索同一条
// wiretime.ParseOffsetInstant 折算成 date-only 周期键，后续过滤仍是字符串比较。
// 非法形态的错误文案引用 wiretime.DateFilterFormatMessage——与 HTTP 家族的
// 400 共用同一示例，不再是各写一份的字面量。
func cleanDateFilter(value *string, field string) (*string, *ReportListToolResult) {
	if value == nil {
		return nil, nil
	}
	parsed, ok := wiretime.ParseOffsetInstant(*value)
	if !ok {
		result := invalid(field + " " + wiretime.DateFilterFormatMessage)
		return nil, &result
	}
	key := parsed.Key
	return &key, nil
}

// cursorValue 是分页游标的 JSON 形状。字段顺序必须与
// JSON.stringify({version, weekEnd, reportId}) 一致，这样编码出的游标字节相同。
type cursorValue struct {
	Version  float64 `json:"version"`
	WeekEnd  string  `json:"weekEnd"`
	ReportID float64 `json:"reportId"`
}

// decodeBase64URL 复刻 Node 的 Buffer.from(value, 'base64url')：忽略字母表外的
// 字符（含 '='、空白、非法符号），同时接受标准与 URL-safe 两种字母表；长度
// 余 1 时丢弃最后一个字符（Node 该情形解出 0 字节，而 Go 会报错）。
func decodeBase64URL(value string) ([]byte, bool) {
	var builder strings.Builder
	builder.Grow(len(value))
	for i := 0; i < len(value); i++ {
		switch c := value[i]; {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			builder.WriteByte(c)
		case c == '+':
			builder.WriteByte('+')
		case c == '/':
			builder.WriteByte('/')
		case c == '-':
			builder.WriteByte('+')
		case c == '_':
			builder.WriteByte('/')
		}
	}
	filtered := builder.String()
	if len(filtered)%4 == 1 {
		filtered = filtered[:len(filtered)-1]
	}
	decoded, err := base64.RawStdEncoding.DecodeString(filtered)
	if err != nil {
		return nil, false
	}
	return decoded, true
}

// parseCursor 复刻 ts 的 parseCursor：base64url → utf8 → JSON.parse → 形状校验。
func parseCursor(value string) *cursorValue {
	decoded, ok := decodeBase64URL(value)
	if !ok {
		return nil
	}
	var parsed cursorValue
	if err := json.Unmarshal(decoded, &parsed); err != nil {
		return nil
	}
	// `parsed.version !== 1 || !Number.isInteger(parsed.reportId) || <= 0`
	if parsed.Version != 1 || math.IsNaN(parsed.ReportID) || parsed.ReportID != math.Trunc(parsed.ReportID) || parsed.ReportID <= 0 {
		return nil
	}
	// typeof weekEnd === 'string' && cleanDate(weekEnd) === weekEnd：JSON 里
	// weekEnd 不是字符串时 Unmarshal 会失败，因此这里只需日历校验。
	if !cleanDate(parsed.WeekEnd) {
		return nil
	}
	return &parsed
}

// encodeCursor 复刻 ts 的 encodeCursor：base64url(JSON.stringify({...}))，
// JSON 属性顺序 version/weekEnd/reportId。
func encodeCursor(weekEnd string, reportID int64) string {
	payload, err := json.Marshal(cursorValue{Version: 1, WeekEnd: weekEnd, ReportID: float64(reportID)})
	if err != nil {
		// 结构体序列化不会失败；保持与 ts 的 catch 分支一致地退化为空游标没有意义，
		// 这里返回空串让调用方看到明显异常（正常路径不会触发）。
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

// normalizeFilters 复刻 ts 的 normalizeFilters。第二个返回值非 nil 表示校验失败。
func normalizeFilters(input ReportListInput, sessionReportID int64) (AppliedReportListFilters, *ReportListToolResult) {
	relation := "overlap"
	if input.Relation != nil {
		relation = *input.Relation
	}
	if relation != "overlap" && relation != "previous_adjacent" {
		result := invalid("relation must be overlap or previous_adjacent")
		return AppliedReportListFilters{}, &result
	}

	title, titleErr := cleanTextFilter(input.Title, "title")
	if titleErr != nil {
		return AppliedReportListFilters{}, titleErr
	}

	statuses := []string{"current"}
	if input.Statuses != nil {
		statuses = *input.Statuses
	}
	if len(statuses) == 0 {
		result := invalid("statuses must contain current or stale")
		return AppliedReportListFilters{}, &result
	}
	for _, status := range statuses {
		if status != "current" && status != "stale" {
			result := invalid("statuses must contain current or stale")
			return AppliedReportListFilters{}, &result
		}
	}

	includeLegacy := input.IncludeLegacy != nil && *input.IncludeLegacy

	if relation == "previous_adjacent" {
		// ts: !Number.isInteger(relativeToReportId) || relativeToReportId !== sessionReportId
		if input.RelativeToReportID == nil ||
			*input.RelativeToReportID != math.Trunc(*input.RelativeToReportID) ||
			*input.RelativeToReportID != float64(sessionReportID) {
			result := invalid("previous_adjacent requires relativeToReportId to be the current session report")
			return AppliedReportListFilters{}, &result
		}
		relative := sessionReportID
		return AppliedReportListFilters{
			Title:              title,
			Statuses:           []string{"current"},
			Relation:           relation,
			RelativeToReportID: &relative,
			Limit:              1,
		}, nil
	}

	query, queryErr := cleanTextFilter(input.Query, "query")
	if queryErr != nil {
		return AppliedReportListFilters{}, queryErr
	}
	startDate, startErr := cleanDateFilter(input.StartDate, "startDate")
	if startErr != nil {
		return AppliedReportListFilters{}, startErr
	}
	endDate, endErr := cleanDateFilter(input.EndDate, "endDate")
	if endErr != nil {
		return AppliedReportListFilters{}, endErr
	}
	if startDate != nil && endDate != nil && *startDate > *endDate {
		result := invalid("startDate must not be after endDate")
		return AppliedReportListFilters{}, &result
	}

	limit := defaultListLimit
	if input.Limit != nil {
		value := *input.Limit
		if value != math.Trunc(value) || value < 1 || value > maxListLimit {
			result := invalid("limit must be an integer from 1 to 20")
			return AppliedReportListFilters{}, &result
		}
		limit = int(value)
	}

	if input.Cursor != nil && parseCursor(*input.Cursor) == nil {
		result := invalid("cursor is invalid")
		return AppliedReportListFilters{}, &result
	}

	return AppliedReportListFilters{
		Query:     query,
		Title:     title,
		StartDate: startDate,
		EndDate:   endDate,
		Statuses:  statuses,
		// ts 的 appliedFilters 原样反映 includeLegacy 的输入（仅当 relation 为
		// overlap 时才走到这里）。
		IncludeLegacy: includeLegacy,
		Relation:      relation,
		Cursor:        input.Cursor,
		Limit:         limit,
	}, nil
}

// jsLower 复刻 String.prototype.toLowerCase 在这两个工具里的可观测行为。
// 与 Go 的 strings.ToLower 只在极少数土耳其语/希腊语上下文规则上有差异，而
// 查询词与周报正文都不做 locale 处理（date/report 内容），差异不可观测；
// B4 的路径扫描已采用同一取舍。
func jsLower(value string) string { return strings.ToLower(value) }

// containsLiteral 复刻 ts 的 containsLiteral：大小写不敏感的摘要包含。
func containsLiteral(value, search string) bool {
	return strings.Contains(jsLower(value), jsLower(search))
}

// lineRange 是一段 0-based、闭区间的行范围。
type lineRange struct{ start, end int }

// matchingRanges 复刻 contentMatches / literalMatches 共用的行段合并逻辑：
// 每个命中行取前后 contextLines 行，若与上一段重叠或相邻则合并；返回合并后的
// 段（未截断）与命中行总数。
func matchingRanges(lines []string, needle string, contextLines int) ([]lineRange, int) {
	lowered := make([]string, len(lines))
	for index, line := range lines {
		lowered[index] = jsLower(line)
	}
	needle = jsLower(needle)
	matchingLines := make([]int, 0)
	for index, line := range lowered {
		if strings.Contains(line, needle) {
			matchingLines = append(matchingLines, index)
		}
	}
	ranges := make([]lineRange, 0, len(matchingLines))
	for _, line := range matchingLines {
		next := lineRange{start: max(0, line-contextLines), end: min(len(lines)-1, line+contextLines)}
		if len(ranges) > 0 {
			previous := &ranges[len(ranges)-1]
			if next.start <= previous.end+1 {
				previous.end = max(previous.end, next.end)
				continue
			}
		}
		ranges = append(ranges, next)
	}
	return ranges, len(matchingLines)
}

// contentMatches 复刻 ts 的 contentMatches：query 命中段（前后各 1 行），
// 最多 3 段，字段固定为 content。行号 1-based。
func contentMatches(content, query string) []ReportListMatch {
	lines := strings.Split(content, "\n")
	ranges, _ := matchingRanges(lines, query, 1)
	if len(ranges) > maxListMatchesPerReport {
		ranges = ranges[:maxListMatchesPerReport]
	}
	matches := make([]ReportListMatch, 0, len(ranges))
	for _, r := range ranges {
		startLine, endLine := r.start+1, r.end+1
		matches = append(matches, ReportListMatch{
			Field:     "content",
			Content:   strings.Join(lines[r.start:r.end+1], "\n"),
			StartLine: &startLine,
			EndLine:   &endLine,
		})
	}
	return matches
}

// afterCursor 复刻 ts 的 afterCursor：(weekEnd, reportId) 严格排在游标之后。
func afterCursor(row authorizedReportRow, cursor *cursorValue) bool {
	if cursor == nil {
		return true
	}
	return row.WeekEnd < cursor.WeekEnd || (row.WeekEnd == cursor.WeekEnd && float64(row.ReportID) < cursor.ReportID)
}

// authorizedReportRow 是 joined 查询 / legacy 映射的统一行形状。
type authorizedReportRow struct {
	ReportID     int64
	Title        string
	WeekStart    string
	WeekEnd      string
	Audience     string
	FinalStatus  string
	FinalContent string
	IsLegacy     bool
	UpdatedAt    int64
}

// baseItem 复刻 ts 的 baseItem。warning 的顺序也一致：stale 先铺，legacy 覆盖
// （legacy 行的 finalStatus 恒为 current，实际不会同时出现）。
func baseItem(row authorizedReportRow) ReportListItem {
	item := ReportListItem{
		ReportID:         row.ReportID,
		Title:            row.Title,
		WeekStart:        row.WeekStart,
		WeekEnd:          row.WeekEnd,
		Audience:         row.Audience,
		FinalStatus:      row.FinalStatus,
		IsLegacy:         row.IsLegacy,
		UpdatedAt:        jsdate.ISOStringFromUnix(row.UpdatedAt),
		ContentAvailable: true,
	}
	if row.FinalStatus == "stale" {
		warning := StaleFinalWarning
		item.Warning = &warning
	}
	if row.IsLegacy {
		warning := LegacyReportWarning
		item.Warning = &warning
	}
	return item
}

// attachMatches 复刻 ts 的 attachMatches：跨全部项共享 20,000 UTF-16 字符预算；
// 一旦某一项放不下就把预算清零，后续项只会得到空 matches（截断标记保持 true）。
func attachMatches(rows []authorizedReportRow, query string) ([]ReportListItem, bool) {
	remainingCharacters := matchCharacterBudget
	truncated := false
	items := make([]ReportListItem, 0, len(rows))
	for _, row := range rows {
		matches := make([]ReportListMatch, 0)
		available := make([]ReportListMatch, 0)
		if containsLiteral(row.Title, query) {
			available = append(available, ReportListMatch{Field: "title", Content: row.Title})
		}
		available = append(available, contentMatches(row.FinalContent, query)...)
		for _, match := range available {
			if jsstr.UTF16Len(match.Content) > remainingCharacters {
				truncated = true
				break
			}
			matches = append(matches, match)
			remainingCharacters -= jsstr.UTF16Len(match.Content)
		}
		if truncated {
			remainingCharacters = 0
		}
		item := baseItem(row)
		item.Matches = &matches
		items = append(items, item)
	}
	return items, truncated
}

// QueryReportListForSession 复刻 queryReportListForSession。它只使用会话上持久化
// 的受众，不接受调用方的 audience 参数。
func QueryReportListForSession(ctx context.Context, queries *db.Queries, sessionID int64, input ReportListInput) ReportListToolResult {
	session, err := queries.GetGenerationSessionAudienceForQueryTools(ctx, sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queryFailed("Generation session is unavailable")
		}
		log.Printf("[generation] Report list query failed: %v", err)
		return queryFailed("Failed to query historical reports")
	}

	relativeWeekStart, err := queries.GetReportWeekStartForQueryTools(ctx, session.ReportID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queryFailed("Current session report is unavailable")
		}
		log.Printf("[generation] Report list query failed: %v", err)
		return queryFailed("Failed to query historical reports")
	}

	filters, invalidResult := normalizeFilters(input, session.ReportID)
	if invalidResult != nil {
		return *invalidResult
	}

	authorizedRows, err := queries.ListAuthorizedReportVariantsForQueryTools(ctx, db.ListAuthorizedReportVariantsForQueryToolsParams{
		Variant:  session.Variant,
		Statuses: filters.Statuses,
	})
	if err != nil {
		log.Printf("[generation] Report list query failed: %v", err)
		return queryFailed("Failed to query historical reports")
	}
	authorized := make([]authorizedReportRow, 0, len(authorizedRows))
	for _, row := range authorizedRows {
		content := ""
		if row.FinalContent != nil {
			content = *row.FinalContent
		}
		authorized = append(authorized, authorizedReportRow{
			ReportID:     row.ReportID,
			Title:        row.Title,
			WeekStart:    row.WeekStart,
			WeekEnd:      row.WeekEnd,
			Audience:     row.Audience,
			FinalStatus:  row.FinalStatus,
			FinalContent: content,
			UpdatedAt:    row.UpdatedAt,
		})
	}

	if filters.IncludeLegacy {
		if session.Variant != "personal" {
			return ReportListToolResult{OK: false, Error: &ToolError{
				Code:    ErrorCodeNotAvailable,
				Message: "legacy report history is available only to personal generation sessions",
			}}
		}
		modernIDs, err := queries.ListReportVariantReportIDsForQueryTools(ctx)
		if err != nil {
			log.Printf("[generation] Report list query failed: %v", err)
			return queryFailed("Failed to query historical reports")
		}
		modern := make(map[int64]struct{}, len(modernIDs))
		for _, id := range modernIDs {
			modern[id] = struct{}{}
		}
		legacyRows, err := queries.ListReportsForQueryTools(ctx)
		if err != nil {
			log.Printf("[generation] Report list query failed: %v", err)
			return queryFailed("Failed to query historical reports")
		}
		for _, row := range legacyRows {
			if _, isModern := modern[row.ID]; isModern {
				continue
			}
			if jsstr.Trim(row.Content) == "" {
				continue
			}
			authorized = append(authorized, authorizedReportRow{
				ReportID:     row.ID,
				Title:        row.Title,
				WeekStart:    row.WeekStart,
				WeekEnd:      row.WeekEnd,
				Audience:     "personal",
				FinalStatus:  "current",
				FinalContent: row.Content,
				IsLegacy:     true,
				UpdatedAt:    row.UpdatedAt,
			})
		}
	}

	// ts 无条件计算 expectedPreviousEnd：parseISO(week_start) - 1 天。
	previous, err := time.Parse("2006-01-02", relativeWeekStart)
	if err != nil {
		// date-fns 对非法输入会在 format() 抛 RangeError，外层 catch 归成 QUERY_FAILED。
		log.Printf("[generation] Report list query failed: %v", err)
		return queryFailed("Failed to query historical reports")
	}
	expectedPreviousEnd := previous.AddDate(0, 0, -1).Format("2006-01-02")

	var cursor *cursorValue
	if filters.Cursor != nil {
		cursor = parseCursor(*filters.Cursor)
	}

	matching := make([]authorizedReportRow, 0, len(authorized))
	for _, row := range authorized {
		if filters.Relation == "previous_adjacent" {
			if row.IsLegacy || row.WeekEnd != expectedPreviousEnd {
				continue
			}
		}
		if filters.Relation == "overlap" {
			if filters.StartDate != nil && row.WeekEnd < *filters.StartDate {
				continue
			}
			if filters.EndDate != nil && row.WeekStart > *filters.EndDate {
				continue
			}
			if !afterCursor(row, cursor) {
				continue
			}
		}
		if filters.Title != nil && !containsLiteral(row.Title, *filters.Title) {
			continue
		}
		if filters.Query != nil && !containsLiteral(row.Title, *filters.Query) && !containsLiteral(row.FinalContent, *filters.Query) {
			continue
		}
		matching = append(matching, row)
	}

	// ts: sort((a, b) => b.weekEnd.localeCompare(a.weekEnd) || b.reportId - a.reportId)
	// ISO 日期串的 localeCompare 与字节序一致。
	sort.SliceStable(matching, func(i, j int) bool {
		if matching[i].WeekEnd != matching[j].WeekEnd {
			return matching[i].WeekEnd > matching[j].WeekEnd
		}
		return matching[i].ReportID > matching[j].ReportID
	})

	hasMore := filters.Relation == "overlap" && len(matching) > filters.Limit
	pageRows := matching
	if len(pageRows) > filters.Limit {
		pageRows = pageRows[:filters.Limit]
	}

	items := make([]ReportListItem, 0, len(pageRows))
	var matchesTruncated *bool
	if filters.Query != nil {
		matched, truncated := attachMatches(pageRows, *filters.Query)
		items = matched
		matchesTruncated = &truncated
	} else {
		for _, row := range pageRows {
			items = append(items, baseItem(row))
		}
	}

	var nextCursor *string
	if hasMore && len(pageRows) > 0 {
		last := pageRows[len(pageRows)-1]
		encoded := encodeCursor(last.WeekEnd, last.ReportID)
		nextCursor = &encoded
	}

	return ReportListToolResult{
		OK:               true,
		Items:            items,
		NextCursor:       nextCursor,
		HasMore:          hasMore,
		AppliedFilters:   filters,
		MatchesTruncated: matchesTruncated,
	}
}
