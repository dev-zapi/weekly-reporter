package templates

import (
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件移植 src/lib/validations.ts 里两个模板 schema（zod）在 HTTP 层可观测的
// 行为：哪些输入算合法、以及合法时各字段的值。zod 的 issue 列表不出现在
// templates 路由的响应里（route.ts 只回 {error:'Validation failed', code}），
// 所以这里只保留布尔判定与解析结果，不复制 issue 形状。

// templateInput 是 templateSchema.parse 之后的字段值。
//
// Description / Tags / AiStyle 用「是否存在」区分 undefined 与值：drizzle 的
// update().set() 会省略 undefined 的键（PUT 的语义依赖这一点），而显式的空串
// 会覆盖列。
type templateInput struct {
	Name        string
	Content     string
	Description optionalString
	Tags        optionalString
	AiStyle     optionalString
}

// optionalString 复刻 zod 里 `z.string().optional()` 的结果：Present=false 即
// JS 的 undefined。
type optionalString struct {
	Value   string
	Present bool
}

// cloneTemplateInput 是 cloneTemplateSchema.parse 之后的字段值。
type cloneTemplateInput struct {
	SourceID string
	Name     optionalString
	Content  optionalString
}

// isValidTemplateBody 复刻 templateSchema.parse(body) 的成功/失败判定。
//
//	z.object({
//	  name: z.string().min(1).max(100),
//	  content: z.string().min(1),
//	  description: z.string().max(200).optional(),
//	  tags: z.string().optional(),
//	  aiStyle: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
//	})
//
// 长度按 UTF-16 码元数比较（JS 的 string.length），所以 CJK 与增补平面字符的
// 计数与字节数、码点数都不同。
func parseTemplateBody(body any) (templateInput, bool) {
	object, ok := asObject(body)
	if !ok {
		return templateInput{}, false
	}

	name, present := object["name"]
	if !present {
		return templateInput{}, false
	}
	nameStr, ok := name.(string)
	if !ok || jsstr.UTF16Len(nameStr) < 1 || jsstr.UTF16Len(nameStr) > 100 {
		return templateInput{}, false
	}

	content, present := object["content"]
	if !present {
		return templateInput{}, false
	}
	contentStr, ok := content.(string)
	if !ok || jsstr.UTF16Len(contentStr) < 1 {
		return templateInput{}, false
	}

	input := templateInput{Name: nameStr, Content: contentStr}

	if raw, present := object["description"]; present {
		str, ok := raw.(string)
		if !ok || jsstr.UTF16Len(str) > 200 {
			return templateInput{}, false
		}
		input.Description = optionalString{Value: str, Present: true}
	}
	if raw, present := object["tags"]; present {
		str, ok := raw.(string)
		if !ok {
			return templateInput{}, false
		}
		input.Tags = optionalString{Value: str, Present: true}
	}
	if raw, present := object["aiStyle"]; present {
		str, ok := raw.(string)
		if !ok || !isStyleKey(str) {
			return templateInput{}, false
		}
		input.AiStyle = optionalString{Value: str, Present: true}
	}

	return input, true
}

// parseStyleOnlyBody 复刻 `templateSchema.pick({ aiStyle: true }).parse(body)`。
// 只有 aiStyle 一个键参与校验；解析成功后 aiStyle 仍可能是 undefined（body 是
// 空对象时），PUT 的 style-only 分支据此只写 updated_at。
func parseStyleOnlyBody(body any) (optionalString, bool) {
	object, ok := asObject(body)
	if !ok {
		return optionalString{}, false
	}
	raw, present := object["aiStyle"]
	if !present {
		return optionalString{}, true
	}
	str, ok := raw.(string)
	if !ok || !isStyleKey(str) {
		return optionalString{}, false
	}
	return optionalString{Value: str, Present: true}, true
}

// parseCloneBody 复刻 cloneTemplateSchema.parse(body)：
//
//	z.object({
//	  sourceId: z.string().min(1),
//	  name: z.string().min(1).max(100).optional(),
//	  content: z.string().optional(),
//	})
func parseCloneBody(body any) (cloneTemplateInput, bool) {
	object, ok := asObject(body)
	if !ok {
		return cloneTemplateInput{}, false
	}

	rawSourceID, present := object["sourceId"]
	if !present {
		return cloneTemplateInput{}, false
	}
	sourceID, ok := rawSourceID.(string)
	if !ok || jsstr.UTF16Len(sourceID) < 1 {
		return cloneTemplateInput{}, false
	}

	input := cloneTemplateInput{SourceID: sourceID}

	if raw, present := object["name"]; present {
		str, ok := raw.(string)
		if !ok || jsstr.UTF16Len(str) < 1 || jsstr.UTF16Len(str) > 100 {
			return cloneTemplateInput{}, false
		}
		input.Name = optionalString{Value: str, Present: true}
	}
	if raw, present := object["content"]; present {
		str, ok := raw.(string)
		if !ok {
			return cloneTemplateInput{}, false
		}
		input.Content = optionalString{Value: str, Present: true}
	}

	return input, true
}

// isStyleKey 复刻 templateSchema 与 aiStyleSchema 共用的 /^[a-z][a-z0-9_-]*$/。
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

// asObject 复刻 zod object 的输入判定：只有 JSON 对象（plain object）通过，
// null / 数组 / 标量都是 ZodError。
func asObject(body any) (map[string]any, bool) {
	object, ok := body.(map[string]any)
	return object, ok
}

// isStyleOnlyUpdate 复刻 `Object.keys(body).every(key => key === 'aiStyle')`。
//
// 非对象输入（数字、布尔、字符串、数组）也返回 false 即可：route.ts 的
// style-only 分支与完整解析分支对它们都产出 400 VALIDATION_ERROR，两条路径
// 的响应相同，所以这里只区分「对象且所有键都是 aiStyle」（含空对象）。
func isStyleOnlyUpdate(body any) bool {
	object, ok := body.(map[string]any)
	if !ok {
		return false
	}
	for key := range object {
		if key != "aiStyle" {
			return false
		}
	}
	return true
}

// decodeBody 复刻 `await request.json()`，语义唯一实现见 jsjson.DecodeBody。
func decodeBody(r *http.Request) (any, error) { return jsjson.DecodeBody(r) }
