package tools

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/lib/generation/report-content-tool.ts（query_report_content）。
// 关键不变量：40,000 字符正文预算、grep 的 maxMatches/contextLines、stale 与
// legacy 的显式授权、leadership 会话的 NOT_AVAILABLE 与非领导版的空结果。

const (
	// maxContentChars 是整份正文（亚或命中片段）的字符预算，按 UTF-16 单元计。
	maxContentChars = 40_000
	// maxQueryChars 是 grep 查询词的 UTF-16 长度上限。
	maxQueryChars = 200
	// defaultMaxMatches / maxMaxMatches 是 maxMatches 的默认值与上限。
	defaultMaxMatches = 5
	maxMaxMatches     = 10
	// defaultContextLines / maxContextLines 是 contextLines 的默认值与上限。
	defaultContextLines = 1
	maxContextLines     = 5
	// truncationMarker 是正文超预算时追加的固定标记。
	truncationMarker = "\n[系统截断：正文超过 40,000 字符]"
)

// sliceUTF16 复刻 JS 的 String.prototype.slice(0, n)（按 UTF-16 单元截断）。
//
// 与 TS 的一个有意边界差异：JS 允许把增补平面字符劈成孤立代理项（随后
// JSON.stringify 会输出 \udXXX 转义），Go 的 string 无法表示孤立代理项；
// 需要劈开时本函数整对舍弃（少 1 个单元），避免产生非法 UTF-8。ADR-0027 的
// 公共 utf16 helper 随引擎票（#110）落地，这里先保留包内实现，避免两个并行
// 分支在公共包里重复定义同一符号。
func sliceUTF16(s string, n int) string {
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

// contentInvalid 构造 content 工具的 INVALID_QUERY 失败结果。
func contentInvalid(message string) ReportContentToolResult {
	return ReportContentToolResult{OK: false, Error: &ToolError{Code: ErrorCodeInvalidQuery, Message: message}}
}

func contentQueryFailed(message string) ReportContentToolResult {
	return ReportContentToolResult{OK: false, Error: &ToolError{Code: ErrorCodeQueryFailed, Message: message}}
}

// contentNotAvailable 是 NOT_AVAILABLE 失败结果。
func contentNotAvailable(message string) ReportContentToolResult {
	return ReportContentToolResult{OK: false, Error: &ToolError{Code: ErrorCodeNotAvailable, Message: message}}
}

// contentNotFound 是成功但未找到的形态。reportId 原样回显入参（TS 用
// Number(params.reportId)），因此保持 float64 以避免超出 int64 的输入被改写。
func contentNotFound(reportID float64) ReportContentToolResult {
	return ReportContentToolResult{OK: true, Found: false, ReportID: reportID}
}

// contentMatchRange 是 literalMatches 产出的 1-based 行段。
type contentMatchRange struct {
	StartLine int
	EndLine   int
	Content   string
}

// literalMatches 复刻 ts 的 literalMatches：按 contextLines 取上下文并合并相邻段，
// 段数截到 maxMatches，同时返回命中行总数（不是段数）。
func literalMatches(content, query string, contextLines, maxMatches int) (int, []contentMatchRange) {
	lines := strings.Split(content, "\n")
	ranges, total := matchingRanges(lines, query, contextLines)
	if len(ranges) > maxMatches {
		ranges = ranges[:maxMatches]
	}
	matches := make([]contentMatchRange, 0, len(ranges))
	for _, r := range ranges {
		matches = append(matches, contentMatchRange{
			StartLine: r.start + 1,
			EndLine:   r.end + 1,
			Content:   strings.Join(lines[r.start:r.end+1], "\n"),
		})
	}
	return total, matches
}

// QueryReportContentForSession 复刻 queryReportContentForSession。
func QueryReportContentForSession(ctx context.Context, queries *db.Queries, sessionID int64, input ReportContentInput) ReportContentToolResult {
	// ts 先做参数形状/范围校验，再查库。
	if input.ReportID == nil || *input.ReportID != math.Trunc(*input.ReportID) || *input.ReportID <= 0 {
		return contentInvalid("reportId must be a positive integer")
	}
	// ts 的 Number(params.reportId) 原样进 drizzle 绑定；超过 int64 的数值在
	// SQLite 侧同样匹配不到任何行。回显（found=false）用原值，查询用 int64。
	reportIDValue := *input.ReportID
	reportID := int64(reportIDValue)

	var query string
	hasQuery := input.Query != nil
	if hasQuery {
		query = jsstr.Trim(*input.Query)
		if length := jsstr.UTF16Len(query); length < 1 || length > maxQueryChars {
			return contentInvalid("query must contain 1 to 200 characters after trimming")
		}
	}

	maxMatches := defaultMaxMatches
	if input.MaxMatches != nil {
		value := *input.MaxMatches
		if value != math.Trunc(value) || value < 1 || value > maxMaxMatches {
			return contentInvalid("maxMatches must be an integer from 1 to 10")
		}
		maxMatches = int(value)
	}

	contextLines := defaultContextLines
	if input.ContextLines != nil {
		value := *input.ContextLines
		if value != math.Trunc(value) || value < 0 || value > maxContextLines {
			return contentInvalid("contextLines must be an integer from 0 to 5")
		}
		contextLines = int(value)
	}

	session, err := queries.GetGenerationSessionAudienceForQueryTools(ctx, sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return contentQueryFailed("Generation session is unavailable")
		}
		log.Printf("[generation] Report content query failed: %v", err)
		return contentQueryFailed("Failed to query historical report content")
	}

	report, err := queries.GetReportForQueryTools(ctx, reportID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return contentNotFound(reportIDValue)
		}
		log.Printf("[generation] Report content query failed: %v", err)
		return contentQueryFailed("Failed to query historical report content")
	}

	variant, err := queries.GetReportVariantForQueryTools(ctx, db.GetReportVariantForQueryToolsParams{
		ReportID: report.ID,
		Variant:  session.Variant,
	})
	hasVariant := true
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("[generation] Report content query failed: %v", err)
			return contentQueryFailed("Failed to query historical report content")
		}
		hasVariant = false
	}

	_, modernErr := queries.GetReportVariantIDForQueryTools(ctx, report.ID)
	isLegacy := errors.Is(modernErr, sql.ErrNoRows)
	if modernErr != nil && !isLegacy {
		log.Printf("[generation] Report content query failed: %v", modernErr)
		return contentQueryFailed("Failed to query historical report content")
	}

	// unavailable 的分叉是这两个工具最容易被写错的地方：领导版一律
	// NOT_AVAILABLE，个人版回成功但 found=false。
	unavailable := func(message string) ReportContentToolResult {
		if session.Variant == "leadership" {
			return contentNotAvailable(message)
		}
		return contentNotFound(reportIDValue)
	}

	if !hasVariant {
		if !isLegacy || session.Variant != "personal" || input.AllowLegacy == nil || !*input.AllowLegacy {
			return unavailable("This historical report is not available for the current audience or authorization")
		}
	} else {
		if variant.FinalStatus == "none" || variant.FinalContent == nil || *variant.FinalContent == "" {
			return unavailable("The requested report has no current final for this audience")
		}
		if variant.FinalStatus == "stale" && (input.AllowStale == nil || !*input.AllowStale) {
			return unavailable("The stale final requires explicit authorization")
		}
	}

	status := "current"
	if hasVariant {
		status = variant.FinalStatus
	}
	content := report.Content
	updatedAt := report.UpdatedAt
	if hasVariant && variant.FinalContent != nil {
		content = *variant.FinalContent
	}
	if hasVariant {
		updatedAt = variant.UpdatedAt
	}

	identity := ReportContentIdentity{
		ReportID:            report.ID,
		Title:               report.Title,
		WeekStart:           report.WeekStart,
		WeekEnd:             report.WeekEnd,
		Audience:            session.Variant,
		FinalStatus:         status,
		IsLegacy:            isLegacy,
		UpdatedAt:           jsdate.ISOStringFromUnix(updatedAt),
		HistoricalReference: HistoricalReferenceLabel,
	}
	if isLegacy {
		warning := LegacyReportWarning
		identity.Warning = &warning
	} else if status == "stale" {
		warning := StaleFinalWarning
		identity.Warning = &warning
	}

	if !hasQuery {
		truncated := jsstr.UTF16Len(content) > maxContentChars
		bounded := content
		if truncated {
			bounded = sliceUTF16(content, maxContentChars-jsstr.UTF16Len(truncationMarker)) + truncationMarker
		}
		totalChars := jsstr.UTF16Len(content)
		returnedChars := jsstr.UTF16Len(bounded)
		return ReportContentToolResult{
			OK:            true,
			Found:         true,
			Identity:      &identity,
			Content:       &bounded,
			Truncated:     truncated,
			ReturnedChars: &returnedChars,
			TotalChars:    &totalChars,
		}
	}

	totalMatches, ranges := literalMatches(content, query, contextLines, maxMatches)

	// ts 的预算是逐段加减、超预算的段直接丢弃（不是 try 后把预算清零）。
	budget := maxContentChars
	matches := make([]ReportContentMatch, 0, len(ranges))
	for _, match := range ranges {
		length := jsstr.UTF16Len(match.Content)
		if length > budget {
			continue
		}
		budget -= length
		matches = append(matches, ReportContentMatch{
			StartLine: match.StartLine,
			EndLine:   match.EndLine,
			Content:   match.Content,
		})
	}
	budgetTruncated := len(matches) < len(ranges)
	truncated := budgetTruncated || totalMatches > maxMatches
	returnedMatches := len(matches)
	return ReportContentToolResult{
		OK:              true,
		Found:           true,
		Identity:        &identity,
		Query:           &query,
		TotalMatches:    &totalMatches,
		ReturnedMatches: &returnedMatches,
		Matches:         &matches,
		Truncated:       truncated,
	}
}
