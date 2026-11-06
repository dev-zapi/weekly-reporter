package tags

import (
	"encoding/json"
	"io"
	"net/http"
)

// 本文件移植 src/lib/validations.ts 的 tagRenameSchema（zod）在 HTTP 层可观测的
// 形状：issue 列表的 path 与 message，以及「哪些输入算非法」。判定顺序照 zod：
// 先 object 类型检查，再按字段顺序（from、to）逐字段跑 string → regex。

// tagCharsetMessage 与 validations.ts 的 tagCharsetMessage 逐字一致。
const tagCharsetMessage = "Tag name may contain only Chinese characters, letters, and digits"

// issue 是 zod issue 的最小投影；route.ts 只回 path.join('.') 与 message。
type issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// issueDetails 是 details 外层形状。
type issueDetails struct {
	Issues []issue `json:"issues"`
}

// decodeJSONBody 复刻 `await request.json()`：读整个 body 再解析。
// 解析失败与 TS 一样是错误（由调用方落进 catch 分支）。
func decodeJSONBody(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	// json.Unmarshal 与 JSON.parse 一样拒绝尾随垃圾，且数字折成 float64。
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}

// validateRenameBody 复刻 `tagRenameSchema.safeParse(body)`，只投影 issues。
// 返回的 from/to 仅在 issues 为空时有效。
func validateRenameBody(body any) (from, to string, issues []issue) {
	object, ok := body.(map[string]any)
	if !ok {
		return "", "", []issue{{Path: "", Message: expectedObjectMessage(body)}}
	}

	// zod 逐个字段收集 issue，不因前一个字段失败而跳过后面那个。
	issues = append(issues, validateTagField("from", object)...)
	issues = append(issues, validateTagField("to", object)...)
	if len(issues) > 0 {
		return "", "", issues
	}
	return object["from"].(string), object["to"].(string), nil
}

func validateTagField(field string, object map[string]any) []issue {
	value, present := object[field]
	if !present {
		return []issue{{Path: field, Message: "Invalid input: expected string, received undefined"}}
	}
	str, ok := value.(string)
	if !ok {
		return []issue{{Path: field, Message: "Invalid input: expected string, received " + jsonTypeName(value)}}
	}
	if !IsValidTagName(str) {
		return []issue{{Path: field, Message: tagCharsetMessage}}
	}
	return nil
}

// jsonTypeName 复刻 zod 的 parsedType：JSON 世界里只可能出现这几种。
func jsonTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// expectedObjectMessage 复刻 zod 在「顶层不是 object」时的 issue message。
func expectedObjectMessage(body any) string {
	return "Invalid input: expected object, received " + jsonTypeName(body)
}
