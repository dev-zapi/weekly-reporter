package settings

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

// 本文件是 settings/ai 域把 JSON body 当 JS 值处理时需要的最小语义：真值判断、
// 字符串化与 Array.prototype.sort() 的默认序。模式与 B2/B4 的 js* 包一致，
// 只镜像 route.ts 里实际出现的分支。

// jsTruthy 复刻 JS 的真值判断（JSON 值域）。
func jsTruthy(v any) bool {
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

// jsStringValue 复刻 `String(value)` 在模型 id 上的可观测形态。模型 id 实际都是
// 字符串；其它类型只在 provider 返回畸形数据时出现，这里给出与 JS 一致的
// 字面量（数字按 JSON.stringify 的紧凑形态，对象是 "[object Object]"）。
func jsStringValue(v any) string {
	switch value := v.(type) {
	case nil:
		return "null"
	case string:
		return value
	case bool:
		if value {
			return "true"
		}
		return "false"
	case float64:
		if value == math.Trunc(value) && math.Abs(value) < 1e21 {
			return strconv.FormatFloat(value, 'f', -1, 64)
		}
		return strconv.FormatFloat(value, 'g', -1, 64)
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			parts = append(parts, jsStringValue(item))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return "undefined"
}

// utf16Less 复刻 JS 字符串比较：逐 UTF-16 码元比较（不是码点、也不是 UTF-8 字节）。
func utf16Less(a, b string) bool {
	au := utf16.Encode([]rune(a))
	bu := utf16.Encode([]rune(b))
	for i := 0; i < len(au) && i < len(bu); i++ {
		if au[i] != bu[i] {
			return au[i] < bu[i]
		}
	}
	return len(au) < len(bu)
}

// modelID 是 `data.data.map(m => m.id)` 的一个元素。
//
// 元素不是对象时 `.id` 是 undefined（JSON 序列化成 null）；undefined 元素在
// Array.prototype.sort() 里总是排到最后且不参与比较。真实 provider 只返回
// 字符串 id，这里保留这个区分是为了畸形数据下也不改变结果形状。
type modelID struct {
	value   any
	defined bool
}

// sortModelIDs 复刻 `models.sort()`（无比较器）：先按 UTF-16 码元序比较已定义
// 元素，undefined 元素保持稳定地挪到末尾。
func sortModelIDs(ids []modelID) []modelID {
	defined := make([]modelID, 0, len(ids))
	undefined := make([]modelID, 0, len(ids))
	for _, id := range ids {
		if id.defined {
			defined = append(defined, id)
		} else {
			undefined = append(undefined, id)
		}
	}
	// sort.SliceStable 与 V8 一样是稳定排序。
	stableSortModelIDs(defined)
	return append(defined, undefined...)
}

func stableSortModelIDs(ids []modelID) {
	// 插入排序：模型列表通常很短，且避免为二十行 comparator 引入 sort 包的
	// interface 噪音。
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0; j-- {
			if !utf16Less(jsStringValue(ids[j].value), jsStringValue(ids[j-1].value)) {
				break
			}
			ids[j], ids[j-1] = ids[j-1], ids[j]
		}
	}
}
