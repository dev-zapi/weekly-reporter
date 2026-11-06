package events

import (
	"encoding/json"
	"io"
	"math"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/tags"
)

// decodeJSON 复刻 `await request.json()`：读整个 body 再解析。
// 解析失败与 route.ts 一样是错误；JSON `null` 返回 (nil, nil)。
//
// 用 json.Unmarshal（而不是 Decoder）有两个目的：拒绝尾随垃圾（JSON.parse 也拒绝），
// 以及把数字折成 float64 —— JS 的 JSON.parse 产出的就是 IEEE-754 double。
func decodeJSON(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}

// objectBody 把「typeof body === 'object' 且 truthy」的 body 折成字段视图。
// 数组在 JS 里也是 object：它没有已知字段，所以等价于空对象。
func objectBody(body any) (map[string]any, bool) {
	switch value := body.(type) {
	case map[string]any:
		return value, true
	case []any:
		return map[string]any{}, true
	}
	return nil, false
}

// coerceDate 复刻 `new Date(value)` 对任意 JSON 值的解释：
// 字符串按 Date Time String Format；数字按 epoch 毫秒；布尔按 0/1；
// null 按 0（`new Date(null)` 是 epoch）；对象/数组按 Invalid Date。
func coerceDate(value any) (jsdate.Parsed, bool) {
	switch v := value.(type) {
	case nil:
		parsed := jsdate.FromMillis(0)
		return parsed, parsed.Valid
	case string:
		parsed := jsdate.ParseString(v)
		return parsed, parsed.Valid
	case float64:
		parsed := jsdate.FromMillis(v)
		return parsed, parsed.Valid
	case bool:
		if v {
			parsed := jsdate.FromMillis(1)
			return parsed, parsed.Valid
		}
		parsed := jsdate.FromMillis(0)
		return parsed, parsed.Valid
	}
	return jsdate.Parsed{}, false
}

// truthyJSON 复刻 JS 的真值判断（`eventTime ? new Date(eventTime) : now`）。
func truthyJSON(v any) bool {
	switch value := v.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case float64:
		return value != 0 && !math.IsNaN(value)
	case []any, map[string]any:
		return true
	}
	return false
}

// isTagName 复用标签域的字集判定（TAG_CHARSET_REGEX）。
func isTagName(s string) bool { return tags.IsValidTagName(s) }
