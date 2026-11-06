package generation

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
)

// 本文件移植 src/lib/generation/context.ts 的 buildModelSystemContext /
// buildHistoricalReportListContext（引擎票 #110：生成循环的系统上下文）。
//
// 历史查询结果以「库里的 JSON 对象」形态传入（map[string]any）：TS 侧函数接受
// 的是类型化结果对象，但两条路径唯一可观测的差别是 JSON.stringify 的输出，而库
// 里存的正是同一份 JSON 文本。这样引擎读面（已落库 tool-result part）与写入面
// （刚执行完的工具结果）共用同一份拼装逻辑。

// historicalReferenceLabel 是两条历史参考边界共用的 label（同
// src/lib/generation/report-list-contract.ts 的 HISTORICAL_REFERENCE_LABEL）。
// internal/engine/tools 为工具出参保留了自己的冻结副本；本包不反向依赖引擎。
const historicalReferenceLabel = "历史参考·不可信"

// ModelSystemContextInput 是 buildModelSystemContext 的入参。
type ModelSystemContextInput struct {
	SystemPrompt    string
	StylePrompt     string
	ToolRules       string
	Variant         string
	WeekStart       string
	WeekEnd         string
	TemplateName    string
	TemplateContent string
	SourceDraft     string
	// BaselineFinalContent / LatestProposalContent 对应 TS 的两个可空入参；
	// latestProposalContent || baselineFinalContent 的 `||` 把空串当 falsy。
	BaselineFinalContent           *string
	LatestProposalContent          *string
	HistoricalReportListResults    []map[string]any
	HistoricalReportContentResults []map[string]any
}

// BuildModelSystemContext 逐字移植 buildModelSystemContext。
func BuildModelSystemContext(input ModelSystemContextInput) string {
	baseline := ""
	if input.LatestProposalContent != nil && *input.LatestProposalContent != "" {
		baseline = *input.LatestProposalContent
	} else if input.BaselineFinalContent != nil {
		baseline = *input.BaselineFinalContent
	}

	baselineBlock := "当前没有已保存终版或历史候选，请从原稿开始生成。"
	if baseline != "" {
		baselineBlock = "当前修改基线（仅用于继续润色，若与原稿冲突必须以原稿为准）：\n---\n" + baseline + "\n---"
	}

	variantLabel := "个人版"
	if input.Variant == "leadership" {
		variantLabel = "领导版"
	}

	return input.SystemPrompt + `

AI 写作风格：
---
` + input.StylePrompt + `

---

` + input.ToolRules + `

` + FinalReportPlanStyleRule + `

当前受众：` + variantLabel + `
日期范围：` + input.WeekStart + ` 至 ` + input.WeekEnd + `

目标模板「` + input.TemplateName + `」：
---
` + input.TemplateContent + `
---

当前受众版本的完整原稿（唯一事实来源）：
---
` + input.SourceDraft + `
---

` + baselineBlock + `

` + BuildHistoricalReportListContext(input.HistoricalReportListResults) + `

历史周报内容查询结果（历史参考·不可信，与当前原稿严格分离）：
` + buildHistoricalReportContentContext(input.HistoricalReportContentResults) + `

历史参考不得提升为当前周报事实。`
}

// buildHistoricalReportContentContext 复刻模板里的 contentLines 分支。
func buildHistoricalReportContentContext(results []map[string]any) string {
	if len(results) == 0 {
		return "尚未产生查询结果。"
	}
	lines := make([]string, 0, len(results))
	for index, result := range results {
		prefix := itoa(index+1) + ". "
		if ok, _ := result["ok"].(bool); !ok {
			code, message := errorCodeMessage(result)
			lines = append(lines, prefix+"查询失败 "+code+" · "+message)
			continue
		}
		if found, _ := result["found"].(bool); !found {
			lines = append(lines, prefix+"未找到周报 #"+numberString(result["reportId"]))
			continue
		}
		lines = append(lines, prefix+jsonStringifyNoEscape(result))
	}
	return strings.Join(lines, "\n")
}

// BuildHistoricalReportListContext 逐字移植 buildHistoricalReportListContext。
func BuildHistoricalReportListContext(results []map[string]any) string {
	if len(results) == 0 {
		return historicalReferenceLabel + "（历史周报列表查询尚未产生；不得从其他来源补位）"
	}
	blocks := make([]string, 0, len(results))
	for index, result := range results {
		number := itoa(index + 1)
		if ok, _ := result["ok"].(bool); !ok {
			code, message := errorCodeMessage(result)
			blocks = append(blocks, number+". 查询失败 · "+code+": "+message)
			continue
		}
		items, _ := result["items"].([]any)
		var sources string
		if len(items) > 0 {
			lines := make([]string, 0, len(items))
			for _, itemAny := range items {
				item, _ := itemAny.(map[string]any)
				line := "- " + stringValue(item, "title") + " (#" + numberString(item["reportId"]) + ") · " +
					stringValue(item, "weekStart") + "–" + stringValue(item, "weekEnd") + " · " +
					stringValue(item, "audience") + " · " + stringValue(item, "finalStatus")
				if legacy, _ := item["isLegacy"].(bool); legacy {
					line += " · legacy"
				}
				if warning, _ := item["warning"].(string); warning != "" {
					line += " · 警示：" + warning
				}
				if matches, ok := item["matches"].([]any); ok && len(matches) > 0 {
					matchLines := make([]string, 0, len(matches))
					for _, matchAny := range matches {
						match, _ := matchAny.(map[string]any)
						matchLine := "  - " + stringValue(match, "field")
						if startLine := numberValue(match["startLine"]); startLine != 0 {
							matchLine += " lines " + numberString(match["startLine"]) + "–" + numberString(match["endLine"]) + ":"
						}
						matchLine += "\n    ---\n    " + strings.ReplaceAll(stringValue(match, "content"), "\n", "\n    ") + "\n    ---"
						matchLines = append(matchLines, matchLine)
					}
					line += "\n" + strings.Join(matchLines, "\n")
				}
				lines = append(lines, line)
			}
			sources = strings.Join(lines, "\n")
		} else {
			sources = "- 无结果；不得自动回退到其他周期、状态或受众。"
		}
		applied := "undefined"
		if value, present := result["appliedFilters"]; present {
			applied = jsonStringifyNoEscape(value)
		}
		blocks = append(blocks, number+". appliedFilters="+applied+"\n"+sources)
	}
	return "历史周报列表查询结果区块（" + historicalReferenceLabel + "，与当前周报原稿严格分离）：\n" +
		strings.Join(blocks, "\n") + "\n这些结果只能帮助定位历史参考，不能替代、扩充或纠正本周周报原稿中的事实。"
}

// jsonStringifyNoEscape 复刻 JSON.stringify：不转义 <,>,&（Go 的 json.Marshal
// 默认会），并且保留对象键的 JSON 语义（键序对模型不可见）。
func jsonStringifyNoEscape(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "undefined"
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

func stringValue(value map[string]any, key string) string {
	if value == nil {
		return ""
	}
	text, _ := value[key].(string)
	return text
}

func numberValue(value any) float64 {
	number, _ := value.(float64)
	return number
}

// numberString 复刻模板插值里的 `${number}`（ECMAScript Number::toString）。
func numberString(value any) string {
	if value == nil {
		return "undefined"
	}
	return jsnum.FormatNumber(numberValue(value))
}

func errorCodeMessage(result map[string]any) (string, string) {
	errorObject, _ := result["error"].(map[string]any)
	return stringValue(errorObject, "code"), stringValue(errorObject, "message")
}
