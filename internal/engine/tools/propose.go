package tools

import (
	"encoding/json"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 generation-tools.ts 里的 proposeFinalReportInputSchema：那个
// `z.strictObject` 的入参边界是本票「测试随票走」清单里 generation-tools.test.ts
// 的唯一被测面（ADR-0014 的 coercion 决策）。
//
// 范围只到「入参边界」：propose 的执行副作用（写 generation_proposals、审计、
// 事务）属于引擎循环票 #110，本文件不碰。

// ProposeFinalReportInputJSONSchema 是 zod v4 `z.toJSONSchema()` 对这个
// strictObject 的逐字节输出。它与 TypeScript 侧同源，因此在引擎把 schema 发给
// provider 时可以直接复用来对齐工具声明。
const ProposeFinalReportInputJSONSchema = `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"content":{"type":"string","minLength":1,"description":"完整的 Markdown 周报候选终版"},"summary":{"type":"array","items":{"type":"string"},"description":"面向用户的简短变更摘要"},"publicSummary":{"type":"object","properties":{"modelHandling":{"type":"array","items":{"type":"string"},"description":"模型显式提供的简短处理说明；不得复制历史正文或推测隐藏推理"}},"required":["modelHandling"],"additionalProperties":false}},"required":["content","summary"],"additionalProperties":false}`

// PublicSummary 是 publicSummary 字段的规范化形状。
type PublicSummary struct {
	ModelHandling []string
}

// ProposeFinalReportInput 是 zod 校验+coercion 之后的值。
type ProposeFinalReportInput struct {
	Content       string
	Summary       []string
	PublicSummary *PublicSummary
}

// ParseProposeFinalReportInput 复刻 proposeFinalReportInputSchema 的
// safeParse：strictObject 拒绝未知键，summary 的裸值被包成单元素数组，
// publicSummary 的裸字符串数组被折成 {modelHandling}，裸字符串被拒绝。
func ParseProposeFinalReportInput(data []byte) (ProposeFinalReportInput, error) {
	object, err := parseRawObject(data, []string{"content", "summary", "publicSummary"})
	if err != nil {
		return ProposeFinalReportInput{}, err
	}

	// content: z.string().min(1)
	content, err := object.optString("content")
	if err != nil {
		return ProposeFinalReportInput{}, err
	}
	if content == nil {
		return ProposeFinalReportInput{}, newInputError("content: Invalid input: expected string, received undefined")
	}
	if jsstr.UTF16Len(*content) < 1 {
		return ProposeFinalReportInput{}, newInputError("content: Too small: expected string to have >=1 characters")
	}

	// summary: z.preprocess(v => Array.isArray(v) ? v : [v], z.array(z.string()))
	summary, err := object.summaryOrWrapped()
	if err != nil {
		return ProposeFinalReportInput{}, err
	}

	input := ProposeFinalReportInput{Content: *content, Summary: summary}

	// publicSummary 是 optional，但显式 null 仍然被 z.preprocess 穿过再被
	// z.object 拒绝（zod 的 optional 只放过 undefined）。
	if _, present := object["publicSummary"]; present {
		publicSummary, err := object.publicSummary()
		if err != nil {
			return ProposeFinalReportInput{}, err
		}
		input.PublicSummary = publicSummary
	}
	return input, nil
}

// summaryOrWrapped 复刻 `z.preprocess(v => Array.isArray(v) ? v : [v], z.array(z.string()))`：
// 任何非数组值都被包进单元素数组，于是只有字符串值能通过（数字/对象/布尔都被
// 元素类型拒绝）。
func (o rawObject) summaryOrWrapped() ([]string, error) {
	raw, present := o["summary"]
	if !present {
		return nil, newInputError("summary: Invalid input: expected array, received undefined")
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, newInputError("summary: Invalid input: expected array")
	}
	items, isArray := value.([]any)
	if !isArray {
		items = []any{value}
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, newInputError("summary[%d]: Invalid input: expected string", index)
		}
		values = append(values, text)
	}
	return values, nil
}

// publicSummary 复刻
// `z.preprocess(v => Array.isArray(v) ? { modelHandling: v } : v, z.object({modelHandling: z.array(z.string())}))`。
//
// 注意 modelHandling 是 z.object 的必需键：对象缺键即失败；对象上的未知键被
// 剥掉（z.object 的非 strict 行为），与 strictObject 的外层不同。
func (o rawObject) publicSummary() (*PublicSummary, error) {
	var value any
	if err := json.Unmarshal(o["publicSummary"], &value); err != nil {
		return nil, newInputError("publicSummary: Invalid input: expected object")
	}
	var object map[string]any
	switch typed := value.(type) {
	case []any:
		object = map[string]any{"modelHandling": typed}
	case map[string]any:
		object = typed
	default:
		// null、裸字符串、数字、布尔：z.preprocess 原样透传后 z.object 拒绝。
		return nil, newInputError("publicSummary: Invalid input: expected object")
	}
	rawModelHandling, present := object["modelHandling"]
	if !present {
		return nil, newInputError("publicSummary.modelHandling: Invalid input: expected array, received undefined")
	}
	items, ok := rawModelHandling.([]any)
	if !ok {
		return nil, newInputError("publicSummary.modelHandling: Invalid input: expected array")
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, newInputError("publicSummary.modelHandling[%d]: Invalid input: expected string", index)
		}
		values = append(values, text)
	}
	return &PublicSummary{ModelHandling: values}, nil
}
