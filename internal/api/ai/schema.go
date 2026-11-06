package ai

import (
	"encoding/json"
	"fmt"
	"math"
)

// 本文件是 zod schema 的 Go 对应物：三条 one-shot 路由的 generateObject 结果
// 校验。schema 常量是 zod v4 `z.toJSONSchema({target:'draft-7'})` 加 AI SDK
// 的 addAdditionalPropertiesToJsonSchema 之后的逐字节输出，随请求发给 provider。
//
// 校验只覆盖 zod 会拒绝的形态（缺键 / 类型不符）。声明之外的未知键在 zod 的
// `z.object` 里是被剥掉而不是报错，因此这里也不拒绝。错误文案只进 500 响应的
// details 诊断字段（route.ts 把 generateObject 的任何失败折成同一个分支）。

// polishSchema 对应 `z.object({ polishedContent: z.string() })`。
const polishSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"polishedContent":{"type":"string"}},"required":["polishedContent"],"additionalProperties":false}`

// expandSchema 对应 `z.object({ newItems: z.array(z.string()) })`。
const expandSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"newItems":{"type":"array","items":{"type":"string"}}},"required":["newItems"],"additionalProperties":false}`

// unifySchema 对应
// `z.object({ unifiedContent: z.string(), changesCount: z.number() })`。
const unifySchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"unifiedContent":{"type":"string"},"changesCount":{"type":"number"}},"required":["unifiedContent","changesCount"],"additionalProperties":false}`

// jsonRaw 把 schema 常量变成请求体里的一段 JSON。
func jsonRaw(constant string) json.RawMessage { return json.RawMessage(constant) }

// decodeObject 复刻 AI SDK 的 parseCompleteOutput：先 JSON.parse 模型输出，再按
// schema 校验。两步任一失败都返回错误。
func decodeObject(text string, validate func(map[string]any) error) (map[string]any, error) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, fmt.Errorf("could not parse the response: %w", err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("response did not match schema: expected object")
	}
	if err := validate(object); err != nil {
		return nil, fmt.Errorf("response did not match schema: %w", err)
	}
	return object, nil
}

// requireString 复刻 `z.string()`：缺键、null 或非字符串都拒绝。
func requireString(object map[string]any, key string) (string, error) {
	raw, present := object[key]
	if !present {
		return "", fmt.Errorf("missing required field %q", key)
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("field %q is not a string", key)
	}
	return value, nil
}

// requireNumber 复刻 `z.number()`。JSON 里没有 NaN/Infinity 字面量，只有超范围
// 字面量（Unmarshal 会报错），所以这里只断言 float64。
func requireNumber(object map[string]any, key string) (float64, error) {
	raw, present := object[key]
	if !present {
		return 0, fmt.Errorf("missing required field %q", key)
	}
	value, ok := raw.(float64)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("field %q is not a number", key)
	}
	return value, nil
}

// requireStringArray 复刻 `z.array(z.string())`。
func requireStringArray(object map[string]any, key string) ([]string, error) {
	raw, present := object[key]
	if !present {
		return nil, fmt.Errorf("missing required field %q", key)
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("field %q is not an array", key)
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		value, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("field %q[%d] is not a string", key, index)
		}
		values = append(values, value)
	}
	return values, nil
}

func validatePolished(object map[string]any) error {
	_, err := requireString(object, "polishedContent")
	return err
}

func validateNewItems(object map[string]any) error {
	_, err := requireStringArray(object, "newItems")
	return err
}

func validateUnified(object map[string]any) error {
	if _, err := requireString(object, "unifiedContent"); err != nil {
		return err
	}
	_, err := requireNumber(object, "changesCount")
	return err
}
