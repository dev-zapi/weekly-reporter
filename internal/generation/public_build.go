package generation

import (
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 src/lib/generation/public-summary.ts 的 buildPublicGenerationSummary
// （提案创建路径的完整审计摘要；读面的 normalizePublicGenerationSummary 已在
// public_summary.go）。
//
// 输入是「已落库的 tool-result 出参 JSON」的 map 形态：引擎在创建提案时把本会话
// 全部历史查询结果喂进来。所有空列表都必须显式初始化为 `[]`——序列化成 null 会被
// 前端 normalizer 静默丢弃（ADR-0027 风险登记 #5）。

const factBoundaryStatement = "当前受众版本的周报原稿是本周已发生工作事实的唯一权威来源；历史参考与公开生成摘要不是本周事实，也不作为评分输入。"

// normalizedAuditText 复刻 NFKC + `\s+`→空格 + trim + toLocaleLowerCase。
func normalizedAuditText(value string) string {
	return strings.ToLower(jsstr.Trim(collapseWhitespace(norm.NFKC.String(value))))
}

type cleanedProseList struct {
	values         []string
	truncatedCount int
}

// cleanPublicProseList 复刻 cleanPublicProseList：
//   - 折叠空白、trim、丢弃空串；
//   - 规范化后包含任一历史正文的条目被丢弃（防止把历史原样复述成摘要素材）；
//   - 每条按 UTF-16 码元截到 maxLength，截短/超限数量进 truncatedCount。
func cleanPublicProseList(values []string, limit, maxLength int, historicalText []string) cleanedProseList {
	safeValues := make([]string, 0, len(values))
	for _, value := range values {
		collapsed := jsstr.Trim(collapseWhitespace(value))
		if collapsed == "" {
			continue
		}
		normalized := normalizedAuditText(collapsed)
		dropped := false
		for _, historical := range historicalText {
			if historical != "" && strings.Contains(normalized, historical) {
				dropped = true
				break
			}
		}
		if !dropped {
			safeValues = append(safeValues, collapsed)
		}
	}

	shortened := make([]string, 0, len(safeValues))
	shortenedCount := 0
	for _, value := range safeValues {
		if jsstr.UTF16Len(value) > maxLength {
			shortenedCount++
		}
		shortened = append(shortened, jsstr.SliceUTF16(value, maxLength))
	}
	omitted := len(shortened) - limit
	if omitted < 0 {
		omitted = 0
	}
	if len(shortened) > limit {
		shortened = shortened[:limit]
	}
	return cleanedProseList{values: shortened, truncatedCount: shortenedCount + omitted}
}

// BuildPublicGenerationSummary 复刻 buildPublicGenerationSummary。
//
// explicitModelHandling 是 propose 入参的 publicSummary.modelHandling（键缺失时
// 为 nil）；changeSummary 是提案的 summary 数组。
func BuildPublicGenerationSummary(
	explicitModelHandling []string,
	changeSummary []string,
	historicalReportListResults []map[string]any,
	historicalReportContentResults []map[string]any,
) map[string]any {
	var historicalText []string
	for _, result := range historicalReportContentResults {
		ok, _ := result["ok"].(bool)
		found, _ := result["found"].(bool)
		if !ok || !found {
			continue
		}
		if content, ok := result["content"].(string); ok && jsstr.Trim(content) != "" {
			historicalText = append(historicalText, normalizedAuditText(content))
		}
		if matches, ok := result["matches"].([]any); ok {
			for _, matchAny := range matches {
				if match, ok := matchAny.(map[string]any); ok {
					if content, ok := match["content"].(string); ok && jsstr.Trim(content) != "" {
						historicalText = append(historicalText, normalizedAuditText(content))
					}
				}
			}
		}
	}

	modelHandling := cleanPublicProseList(explicitModelHandling, 8, 280, historicalText)

	queried := newOrderedReferences()
	for _, result := range historicalReportListResults {
		if ok, _ := result["ok"].(bool); !ok {
			continue
		}
		items, _ := result["items"].([]any)
		for _, itemAny := range items {
			if item, ok := itemAny.(map[string]any); ok {
				queried.set(referenceKey(item), queriedHistoricalReference(item))
			}
		}
	}
	for _, result := range historicalReportContentResults {
		ok, _ := result["ok"].(bool)
		found, _ := result["found"].(bool)
		if !ok || !found {
			continue
		}
		identity, ok := result["identity"].(map[string]any)
		if !ok {
			continue
		}
		if stringValue(identity, "finalStatus") == "none" {
			continue
		}
		item := cloneMap(identity)
		if stringValue(item, "finalStatus") == "stale" {
			item["finalStatus"] = "stale"
		} else {
			item["finalStatus"] = "current"
		}
		queried.set(referenceKey(item), queriedHistoricalReference(item))
	}

	referenceChanges := make([]string, 0, queried.len())
	for _, item := range queried.valuesInOrder() {
		warning := historicalReferenceLabel
		if value, ok := item["warning"].(string); ok && value != "" {
			warning = value
		}
		isLegacy, _ := item["isLegacy"].(bool)
		statusLabel := stringValue(item, "finalStatus")
		if isLegacy {
			statusLabel = "legacy"
		}
		referenceChanges = append(referenceChanges, "历史参考："+stringValue(item, "title")+" · "+
			stringValue(item, "weekStart")+"–"+stringValue(item, "weekEnd")+" · "+
			stringValue(item, "audience")+" · "+statusLabel+" · "+warning)
	}

	change := cleanPublicProseList(append(referenceChanges, changeSummary...), 12, 280, historicalText)

	failureStates := make([]map[string]any, 0)
	toolStatuses := make([]map[string]any, 0)
	historyTruncations := make([]map[string]any, 0)
	recordTool := func(toolName string, result map[string]any) {
		if ok, _ := result["ok"].(bool); !ok {
			code, message := errorCodeMessage(result)
			toolStatuses = append(toolStatuses, map[string]any{"toolName": toolName, "status": "failed", "detail": code})
			failureStates = append(failureStates, map[string]any{"scope": toolName, "code": code, "message": message})
			return
		}
		truncated := false
		if value, ok := result["truncated"].(bool); ok && value {
			truncated = true
		}
		if value, ok := result["matchesTruncated"].(bool); ok && value {
			truncated = true
		}
		if truncated {
			toolStatuses = append(toolStatuses, map[string]any{"toolName": toolName, "status": "truncated", "detail": "bounded-output"})
			historyTruncations = append(historyTruncations, map[string]any{
				"scope": toolName, "omittedCount": 1,
				"message": "历史查询结果已达到字符或片段预算，后续节选被省略。",
			})
			return
		}
		toolStatuses = append(toolStatuses, map[string]any{"toolName": toolName, "status": "succeeded", "detail": "none"})
	}
	for _, result := range historicalReportListResults {
		recordTool("query_report_list", result)
	}
	for _, result := range historicalReportContentResults {
		recordTool("query_report_content", result)
	}

	truncationStates := historyTruncations
	if modelHandling.truncatedCount > 0 {
		truncationStates = append(truncationStates, map[string]any{
			"scope": "model-handling", "omittedCount": modelHandling.truncatedCount,
			"message": "模型显式处理说明有 " + itoa(modelHandling.truncatedCount) + " 项被截短或省略。",
		})
	}
	if change.truncatedCount > 0 {
		truncationStates = append(truncationStates, map[string]any{
			"scope": "proposal-change-summary", "omittedCount": change.truncatedCount,
			"message": "提案变更摘要有 " + itoa(change.truncatedCount) + " 项被截短或省略。",
		})
	}

	toolStatuses = append(toolStatuses, map[string]any{"toolName": "propose_final_report", "status": "succeeded", "detail": "proposal-created"})
	return map[string]any{
		"version":              1,
		"modelHandling":        modelHandling.values,
		"historicalReferences": queried.valuesInOrder(),
		"toolStatuses":         toolStatuses,
		"failureStates":        failureStates,
		"truncationStates":     truncationStates,
		"changeSummary":        change.values,
		"factBoundary": map[string]any{
			"currentWeekFacts":     "report-source-draft-only",
			"historicalReferences": "untrusted",
			"hiddenReasoning":      "none",
			"summaryAsFact":        "none",
			"scoringInput":         "none",
			"statement":            factBoundaryStatement,
		},
	}
}

func queriedHistoricalReference(item map[string]any) map[string]any {
	isLegacy, _ := item["isLegacy"].(bool)
	reference := map[string]any{
		"kind":               "report-query",
		"reportId":           numberValue(item["reportId"]),
		"title":              stringValue(item, "title"),
		"audience":           stringValue(item, "audience"),
		"weekStart":          stringValue(item, "weekStart"),
		"weekEnd":            stringValue(item, "weekEnd"),
		"finalStatus":        stringValue(item, "finalStatus"),
		"isLegacy":           isLegacy,
		"acceptedProposalId": "none",
		"snapshotCapturedAt": "none",
		"sourceUpdatedAt":    stringValue(item, "updatedAt"),
		"trust":              "historical-reference-untrusted",
	}
	if warning, ok := item["warning"].(string); ok && warning != "" {
		reference["warning"] = warning
	}
	return reference
}

func referenceKey(item map[string]any) string {
	return numberString(item["reportId"]) + ":" + stringValue(item, "audience")
}

func cloneMap(source map[string]any) map[string]any {
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

// orderedReferences 复刻 TS 的 Map 插入序（含「重复键保持首次位置、值更新」）。
type orderedReferences struct {
	order  []string
	values map[string]map[string]any
}

func newOrderedReferences() *orderedReferences {
	return &orderedReferences{values: make(map[string]map[string]any)}
}

func (r *orderedReferences) set(key string, value map[string]any) {
	if _, present := r.values[key]; !present {
		r.order = append(r.order, key)
	}
	r.values[key] = value
}

func (r *orderedReferences) len() int { return len(r.order) }

func (r *orderedReferences) valuesInOrder() []map[string]any {
	out := make([]map[string]any, 0, len(r.order))
	for _, key := range r.order {
		out = append(out, r.values[key])
	}
	return out
}
