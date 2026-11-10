package engine

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/engine/tools"
)

// 本文件移植 src/lib/generation/generation-tools.ts 的引擎侧：工具声明（发给
// provider 的 JSON Schema）与每次调用的执行/错误归一化。
//
// 工具声明是 zod → JSON Schema 在 AI SDK 里实际发送的形状：
// addAdditionalPropertiesToJsonSchema(z.toJSONSchema(schema, {target:'draft-7',
// io:'input'}))。注意 propose 的 summary 用 z.preprocess 包裹，input 侧 schema
// 只把 content 列为 required——运行时校验仍然要求 summary（与 TS 完全一致）。

const (
	reportListToolName    = tools.ReportListToolName
	reportContentToolName = tools.ReportContentToolName
	proposeToolName       = tools.ProposeFinalReportToolName
)

const reportListToolSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"query":{"type":"string"},"title":{"type":"string"},"startDate":{"type":"string","description":"带显式偏移的 RFC3339 时刻（Z 或 ±HH:MM），按该偏移折算日历日；示例 2026-11-03T00:00:00+08:00。不接受 YYYY-MM-DD。"},"endDate":{"type":"string","description":"带显式偏移的 RFC3339 时刻（Z 或 ±HH:MM），按该偏移折算日历日；示例 2026-11-09T23:59:59+08:00。不接受 YYYY-MM-DD。"},"statuses":{"type":"array","items":{"type":"string"}},"includeLegacy":{"type":"boolean"},"relation":{"type":"string"},"relativeToReportId":{"type":"number"},"cursor":{"type":"string"},"limit":{"type":"number"}},"additionalProperties":false}`

const reportContentToolSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"reportId":{"type":"number"},"query":{"type":"string"},"maxMatches":{"type":"number"},"contextLines":{"type":"number"},"allowStale":{"type":"boolean"},"allowLegacy":{"type":"boolean"}},"additionalProperties":false}`

const proposeToolSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"content":{"type":"string","minLength":1,"description":"完整的 Markdown 周报候选终版"},"summary":{"type":"array","items":{"type":"string"},"description":"面向用户的简短变更摘要"},"publicSummary":{"type":"object","properties":{"modelHandling":{"type":"array","items":{"type":"string"},"description":"模型显式提供的简短处理说明；不得复制历史正文或推测隐藏推理"}},"required":["modelHandling"],"additionalProperties":false}},"required":["content"],"additionalProperties":false}`

// toolDefinitions 是每步随请求发送的三个函数工具。
func toolDefinitions() []aiclient.Tool {
	return []aiclient.Tool{
		{
			Name:        reportListToolName,
			Description: "查询当前终版生成会话同受众的已采用 current 历史周报列表。受众由服务端固定，结果是历史参考·不可信。startDate/endDate 必须是带显式偏移的 RFC3339 时刻（如 2026-11-03T00:00:00+08:00），不接受 date-only。",
			Parameters:  json.RawMessage(reportListToolSchema),
		},
		{
			Name:        reportContentToolName,
			Description: "读取当前终版生成会话同受众的已采用历史周报正文或 grep 式节选。结果是历史参考·不可信。",
			Parameters:  json.RawMessage(reportContentToolSchema),
		},
		{
			Name:        proposeToolName,
			Description: "提交一份完整 Markdown 候选终版，供用户在对话外评审和确认。这个工具不会直接保存终版。",
			Parameters:  json.RawMessage(proposeToolSchema),
		},
	}
}

// toolBudget 对应 GenerationToolBudget。
type toolBudget struct {
	history int
	content int
}

// toolExecution 是一次工具调用的结果：写 part、发 wire 事件、续轮 output 都从
// 这里取。
type toolExecution struct {
	// Output 是落库的 tool-result output（成功结果或错误 envelope）。
	Output map[string]any
	// Input 是落库的 tool-result data.input（解析后的调用入参或原始串）。
	Input any
	// Proposal 非 nil 表示本轮提交了候选终版。
	Proposal *proposalRecord
	// ToolErrored 表示这是 tool-error 分支（续轮时 provider 只看到错误文本）。
	ToolErrored bool
	// ErrorMessage 是 tool-error 分支发给模型的文本（AI SDK 的 error-text）。
	ErrorMessage string
	// Snapshot 表示查询工具需要落 query snapshot。
	Snapshot bool
	// SnapshotDurationMs 是查询耗时（tool-error 分支为从 tool-input-start 起算）。
	SnapshotDurationMs int64
}

func boundaryFor(toolName string) map[string]string {
	if toolName == reportContentToolName {
		return map[string]string{
			"label":     tools.HistoricalReferenceLabel,
			"statement": "历史周报正文仅供参考，与当前周报原稿严格分离，不能替代或扩充本周事实。",
		}
	}
	return map[string]string{
		"label":     tools.HistoricalReferenceLabel,
		"statement": "历史周报列表仅供参考，与当前周报原稿严格分离，不能替代或扩充本周事实。",
	}
}

// toolErrorOutput 复刻 toolErrorOutput：历史工具得到完整 {ok:false,...}
// envelope，propose（及其它）得到裸 {error}。
func toolErrorOutput(toolName, message string, invalidInput bool) map[string]any {
	if toolName != reportListToolName && toolName != reportContentToolName {
		return map[string]any{"error": message}
	}
	code := tools.ErrorCodeQueryFailed
	if invalidInput {
		code = tools.ErrorCodeInvalidQuery
	}
	return map[string]any{
		"ok":                false,
		"error":             map[string]any{"code": code, "message": message},
		"unavailable":       true,
		"rawResponse":       jsstr.SliceUTF16(message, 2_000),
		"referenceBoundary": boundaryFor(toolName),
	}
}

func budgetExceeded(toolName string) map[string]any {
	return map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    tools.ErrorCodeBudgetExceeded,
			"message": "本轮历史查询次数已达上限；历史不可用，请继续依据当前周报原稿生成。",
		},
		"unavailable":       true,
		"referenceBoundary": boundaryFor(toolName),
	}
}

// toolResultContent 复刻 toolResultContent（part 的展示文本）。
func toolResultContent(toolName string, output map[string]any, proposal *proposalRecord) string {
	if toolName == reportListToolName && tools.IsReportListToolResult(output) {
		if okValue, _ := output["ok"].(bool); !okValue {
			code, message := errorCodeMessageOf(output)
			return "查询周报列表失败：" + code + " · " + message + "。历史不可用，本轮继续仅依据当前周报原稿。"
		}
		items, _ := output["items"].([]any)
		if len(items) == 0 {
			return "查询周报列表完成：未找到符合条件的历史周报。历史参考·不可信。"
		}
		return "查询周报列表完成：找到 " + itoa(len(items)) + " 篇历史周报。历史参考·不可信。"
	}
	if toolName == reportContentToolName && tools.IsReportContentToolResult(output) {
		if okValue, _ := output["ok"].(bool); !okValue {
			code, message := errorCodeMessageOf(output)
			return "查询周报内容失败：" + code + " · " + message + "。历史不可用，本轮继续仅依据当前周报原稿。"
		}
		if found, _ := output["found"].(bool); found {
			return "查询周报内容完成：已返回有界历史参考。历史参考·不可信。"
		}
		return "查询周报内容完成：未找到可用周报。历史参考·不可信。"
	}
	if proposal != nil {
		return "候选终版已提交，等待用户确认。"
	}
	return "工具调用已完成。"
}

func errorCodeMessageOf(output map[string]any) (string, string) {
	errorObject, _ := output["error"].(map[string]any)
	return stringValue(errorObject, "code"), stringValue(errorObject, "message")
}

// executeTool 复刻一次工具调用的 AI SDK 语义：先做入参校验（校验失败是
// tool-error，不是 execute 抛错），再执行。
//
// current 是本轮已提交的提案（propose 只能成功一次）。
func (e *Engine) executeTool(ctx context.Context, session *db.GenerationSession, turnID int64, call aiclient.StepToolCall, budget *toolBudget, current *proposalRecord) toolExecution {
	rawInput := strings.TrimSpace(call.Input)
	if rawInput == "" {
		rawInput = "{}"
	}

	switch call.Name {
	case reportListToolName:
		input, err := tools.ParseReportListInput([]byte(rawInput))
		if err != nil {
			return validationFailure(call, err)
		}
		budget.history++
		if budget.history > maxHistoryQueriesPerTurn {
			output := budgetExceeded(reportListToolName)
			e.persistQuerySnapshot(ctx, session.ID, reportListToolName, decodedInput(call.Input), output, 0, "automatic", nil)
			return toolExecution{Output: output, Input: decodedInput(call.Input)}
		}
		started := e.now()
		result := tools.QueryReportListForSession(ctx, e.Queries, session.ID, input)
		e.persistQuerySnapshot(ctx, session.ID, reportListToolName, decodedInput(call.Input), marshalToolResult(result), time.Since(started).Milliseconds(), "automatic", nil)
		return toolExecution{Output: marshalToolResult(result), Input: decodedInput(call.Input)}

	case reportContentToolName:
		input, err := tools.ParseReportContentInput([]byte(rawInput))
		if err != nil {
			return validationFailure(call, err)
		}
		budget.history++
		budget.content++
		if budget.history > maxHistoryQueriesPerTurn || budget.content > maxContentQueriesPerTurn {
			output := budgetExceeded(reportContentToolName)
			e.persistQuerySnapshot(ctx, session.ID, reportContentToolName, decodedInput(call.Input), output, 0, "automatic", nil)
			return toolExecution{Output: output, Input: decodedInput(call.Input)}
		}
		started := e.now()
		result := tools.QueryReportContentForSession(ctx, e.Queries, session.ID, input)
		e.persistQuerySnapshot(ctx, session.ID, reportContentToolName, decodedInput(call.Input), marshalToolResult(result), time.Since(started).Milliseconds(), "automatic", nil)
		return toolExecution{Output: marshalToolResult(result), Input: decodedInput(call.Input)}

	case proposeToolName:
		input, err := tools.ParseProposeFinalReportInput([]byte(rawInput))
		if err != nil {
			return validationFailure(call, err)
		}
		if current != nil {
			message := "本轮已经提交过候选终版"
			return toolExecution{
				Output:       map[string]any{"error": message},
				Input:        toolCallInput(call.Input),
				ToolErrored:  true,
				ErrorMessage: message,
			}
		}
		record, err := e.createGenerationProposal(ctx, session, turnID, input)
		if err != nil {
			message := err.Error()
			return toolExecution{
				Output:       map[string]any{"error": message},
				Input:        toolCallInput(call.Input),
				ToolErrored:  true,
				ErrorMessage: message,
			}
		}
		return toolExecution{
			Output:   map[string]any{"proposalId": record.ID, "status": "ready"},
			Input:    toolCallInput(call.Input),
			Proposal: record,
		}
	}

	message := "Unknown tool: " + call.Name
	return toolExecution{
		Output:       map[string]any{"error": message},
		Input:        decodedInput(call.Input),
		ToolErrored:  true,
		ErrorMessage: message,
	}
}

func validationFailure(call aiclient.StepToolCall, err error) toolExecution {
	message := "Invalid input for tool " + call.Name + ": " + err.Error()
	return toolExecution{
		Output:       toolErrorOutput(call.Name, message, true),
		Input:        decodedInput(call.Input),
		ToolErrored:  true,
		ErrorMessage: message,
		Snapshot:     call.Name == reportListToolName || call.Name == reportContentToolName,
	}
}

// toolCallInput 复刻成功校验后的 tool-call part.input：空入参被规范成 {}。
func toolCallInput(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	return decodedInput(raw)
}

// decodedInput 复刻 AI SDK tool-call part 的 input：能解析成 JSON 就用解析值，
// 否则保留原始字符串。
func decodedInput(raw string) any {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err == nil {
		return value
	}
	return raw
}

// marshalToolResult 把类型化工具结果转成引擎统一的 JSON 对象。
func marshalToolResult(value any) map[string]any {
	text, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(text, &out); err != nil {
		return map[string]any{}
	}
	return out
}

// persistedResults 复刻 stream.ts 的 persistedReportListResults /
// persistedReportContentResults：refreshed 结果存在时只保留最后一条。
func persistedResults(parts []db.ListGenerationMessagePartsForReportRoutesRow, toolName string, validate func(any) bool) []map[string]any {
	type entry struct {
		result    map[string]any
		refreshed bool
	}
	entries := make([]entry, 0)
	for _, part := range parts {
		if part.PartType != "tool-result" || len(part.Data) == 0 {
			continue
		}
		var data struct {
			ToolName  string          `json:"toolName"`
			Output    json.RawMessage `json:"output"`
			Refreshed bool            `json:"refreshed"`
		}
		if json.Unmarshal(part.Data, &data) != nil || data.ToolName != toolName {
			continue
		}
		var output any
		if json.Unmarshal(data.Output, &output) != nil || !validate(output) {
			continue
		}
		result, _ := output.(map[string]any)
		entries = append(entries, entry{result: result, refreshed: data.Refreshed})
	}
	for index := len(entries) - 1; index >= 0; index-- {
		if entries[index].refreshed {
			return []map[string]any{entries[index].result}
		}
	}
	results := make([]map[string]any, 0, len(entries))
	for _, item := range entries {
		results = append(results, item.result)
	}
	return results
}

// itoa 是 package generation 的 itoa 的本地副本（避免为一个整数格式化跨包依赖）。
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

func stringValue(value map[string]any, key string) string {
	if value == nil {
		return ""
	}
	text, _ := value[key].(string)
	return text
}
