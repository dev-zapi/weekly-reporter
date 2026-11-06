package prompts

import (
	"math"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 src/lib/validations.ts 的 aiStyleSchema / systemPromptSchema（zod）
// 在 HTTP 层可观测的行为。prompts 路由的 zod 失败响应不带 issue 列表
// （route.ts 只回 {error:'Validation failed', code:'VALIDATION_ERROR'}），
// 所以这里只保留判定与解析结果。

const (
	temperatureDefault = 0.3
)

// optionalString 复刻 zod 的 `z.string().optional()` 结果：Present=false 即
// JS 的 undefined（JSON 里不可能出现 undefined 字面量，只可能是「键缺失」）。
type optionalString struct {
	Value   string
	Present bool
}

type optionalBool struct {
	Value   bool
	Present bool
}

// aiStyleInput 是 aiStyleSchema.parse（full）或 .partial().parse 的结果。
//
// Temperature 恒有值：schema 上的 `.default(0.3)` 在 partial() 模式下仍然生效
// （zod 4 实测 `partial().parse({})` → `{temperature: 0.3}`），所以 PUT 不带
// temperature 时会把它写成 "0.3"，这是 TS 侧的真实行为。
type aiStyleInput struct {
	Key            optionalString
	Label          optionalString
	SystemPrompt   optionalString
	Temperature    float64
	DetailLevel    optionalString
	ResultOriented optionalString
	IsDefault      optionalBool
}

// parseAIStyleBody 复刻 aiStyleSchema.parse(body)（POST 用，全部必填项校验）。
func parseAIStyleBody(body any) (aiStyleInput, bool) {
	input, ok := parseAIStylePartialBody(body)
	if !ok {
		return aiStyleInput{}, false
	}
	if !input.Key.Present || !input.Label.Present || !input.SystemPrompt.Present {
		return aiStyleInput{}, false
	}
	return input, true
}

// parseAIStylePartialBody 复刻 aiStyleSchema.partial().parse(body)（PUT 用）。
func parseAIStylePartialBody(body any) (aiStyleInput, bool) {
	object, ok := body.(map[string]any)
	if !ok {
		return aiStyleInput{}, false
	}

	input := aiStyleInput{Temperature: temperatureDefault}

	if raw, present := object["key"]; present {
		str, ok := raw.(string)
		if !ok || jsstr.UTF16Len(str) < 1 || jsstr.UTF16Len(str) > 50 || !isStyleKey(str) {
			return aiStyleInput{}, false
		}
		input.Key = optionalString{Value: str, Present: true}
	}
	if raw, present := object["label"]; present {
		str, ok := raw.(string)
		if !ok || jsstr.UTF16Len(str) < 1 || jsstr.UTF16Len(str) > 50 {
			return aiStyleInput{}, false
		}
		input.Label = optionalString{Value: str, Present: true}
	}
	if raw, present := object["systemPrompt"]; present {
		str, ok := raw.(string)
		if !ok || jsstr.UTF16Len(str) < 1 || jsstr.UTF16Len(str) > 5000 {
			return aiStyleInput{}, false
		}
		input.SystemPrompt = optionalString{Value: str, Present: true}
	}
	if raw, present := object["temperature"]; present {
		number, ok := raw.(float64)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 2 {
			return aiStyleInput{}, false
		}
		input.Temperature = number
	}
	if raw, present := object["detailLevel"]; present {
		str, ok := raw.(string)
		if !ok || !isDetailLevel(str) {
			return aiStyleInput{}, false
		}
		input.DetailLevel = optionalString{Value: str, Present: true}
	}
	if raw, present := object["resultOriented"]; present {
		str, ok := raw.(string)
		if !ok || !isDetailLevel(str) {
			return aiStyleInput{}, false
		}
		input.ResultOriented = optionalString{Value: str, Present: true}
	}
	if raw, present := object["isDefault"]; present {
		value, ok := raw.(bool)
		if !ok {
			return aiStyleInput{}, false
		}
		input.IsDefault = optionalBool{Value: value, Present: true}
	}

	return input, true
}

func isDetailLevel(value string) bool {
	return value == "low" || value == "medium" || value == "high"
}

// parseSystemPromptBody 复刻 systemPromptSchema.parse(body)：
// `z.object({ promptText: z.string().min(1).max(10000) })`。
func parseSystemPromptBody(body any) (string, bool) {
	object, ok := body.(map[string]any)
	if !ok {
		return "", false
	}
	raw, present := object["promptText"]
	if !present {
		return "", false
	}
	text, ok := raw.(string)
	if !ok || jsstr.UTF16Len(text) < 1 || jsstr.UTF16Len(text) > 10000 {
		return "", false
	}
	return text, true
}

// isStyleKey 复刻 /^[a-z][a-z0-9_-]*$/（与 templates 域同一条正则；两个包各自
// 持有是为了不让 prompts 反向依赖 templates 路由包）。
func isStyleKey(value string) bool {
	if value == "" {
		return false
	}
	if value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for i := 1; i < len(value); i++ {
		b := value[i]
		switch {
		case b >= 'a' && b <= 'z', b >= '0' && b <= '9', b == '_', b == '-':
		default:
			return false
		}
	}
	return true
}
