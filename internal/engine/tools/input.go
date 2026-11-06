package tools

import (
	"encoding/json"
	"fmt"
	"math"
)

// 本文件复刻 zod 的 strictObject 入参校验：generation-tools.ts 里两个查询工具都用
// `z.strictObject({...})` 声明入参，未知键与类型不符都会让 AI SDK 抛
// AI_InvalidToolInputError，引擎把它归一成 INVALID_QUERY 的 tool-error 结果。
// 所以「严格」必须发生在解析阶段，语义校验（范围、日期格式、cursor）留给
// normalizeFilters —— 与 TS 的分工一致。
//
// 与 zod 的一个可见差异必须显式处理：zod 的 `.optional()` 只接受「键缺失」，
// 不接受显式 null，而 Go 的 *T 把两者都解成 nil。因此这里先解成
// map[string]json.RawMessage 再逐键判空，不直接 Unmarshal 到结构体。

// inputError 是入参结构校验失败。message 只进 tool-error 的 error.message，
// 不会被任何冻结契约逐字断言（e2e 只看 code）。
type inputError struct{ message string }

func (e *inputError) Error() string { return e.message }

func newInputError(format string, args ...any) *inputError {
	return &inputError{message: fmt.Sprintf(format, args...)}
}

// rawObject 是「先按原始 JSON 收下、再逐字段校验」的中间表示。
type rawObject map[string]json.RawMessage

// parseRawObject 复刻 z.strictObject 对顶层值的要求：必须是 JSON 对象。
func parseRawObject(data []byte, allowed []string) (rawObject, error) {
	var object rawObject
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, newInputError("Invalid input: expected object")
	}
	if object == nil {
		return nil, newInputError("Invalid input: expected object, received null")
	}
	for key := range object {
		known := false
		for _, name := range allowed {
			if name == key {
				known = true
				break
			}
		}
		if !known {
			return nil, newInputError("Unrecognized key: %q", key)
		}
	}
	return object, nil
}

// isAbsent 判断键是否缺失或显式 null（zod 的 optional 只放过前者）。
func (o rawObject) isAbsent(key string) (absent bool, null bool) {
	raw, present := o[key]
	if !present {
		return true, false
	}
	if string(raw) == "null" {
		return true, true
	}
	return false, false
}

func (o rawObject) optString(key string) (*string, error) {
	absent, null := o.isAbsent(key)
	if absent {
		if null {
			return nil, newInputError("%s: Invalid input: expected string, received null", key)
		}
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(o[key], &value); err != nil {
		return nil, newInputError("%s: Invalid input: expected string", key)
	}
	return &value, nil
}

// optNumber 复刻 z.number()：JSON 里只有数字字面量能过，NaN/Infinity 不存在。
func (o rawObject) optNumber(key string) (*float64, error) {
	absent, null := o.isAbsent(key)
	if absent {
		if null {
			return nil, newInputError("%s: Invalid input: expected number, received null", key)
		}
		return nil, nil
	}
	var value float64
	if err := json.Unmarshal(o[key], &value); err != nil {
		return nil, newInputError("%s: Invalid input: expected number", key)
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, newInputError("%s: Invalid input: expected number", key)
	}
	return &value, nil
}

func (o rawObject) optBool(key string) (*bool, error) {
	absent, null := o.isAbsent(key)
	if absent {
		if null {
			return nil, newInputError("%s: Invalid input: expected boolean, received null", key)
		}
		return nil, nil
	}
	var value bool
	if err := json.Unmarshal(o[key], &value); err != nil {
		return nil, newInputError("%s: Invalid input: expected boolean", key)
	}
	return &value, nil
}

// optStringArray 复刻 z.array(z.string())：元素必须全是字符串，null 元素与
// 非数组都拒绝。
func (o rawObject) optStringArray(key string) (*[]string, error) {
	absent, null := o.isAbsent(key)
	if absent {
		if null {
			return nil, newInputError("%s: Invalid input: expected array, received null", key)
		}
		return nil, nil
	}
	var items []any
	if err := json.Unmarshal(o[key], &items); err != nil {
		return nil, newInputError("%s: Invalid input: expected array", key)
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		value, ok := item.(string)
		if !ok {
			return nil, newInputError("%s[%d]: Invalid input: expected string", key, index)
		}
		values = append(values, value)
	}
	return &values, nil
}

// ReportListInput 是 query_report_list 的入参（z.strictObject 的可选键集）。
// 指针为 nil 表示键缺失；语义默认值在 normalizeFilters 里补，和 TS 一致。
type ReportListInput struct {
	Query              *string
	Title              *string
	StartDate          *string
	EndDate            *string
	Statuses           *[]string
	IncludeLegacy      *bool
	Relation           *string
	RelativeToReportID *float64
	Cursor             *string
	Limit              *float64
}

// ParseReportListInput 按 zod 的 strictObject 语义解析工具入参。
func ParseReportListInput(data []byte) (ReportListInput, error) {
	object, err := parseRawObject(data, []string{
		"query", "title", "startDate", "endDate", "statuses", "includeLegacy",
		"relation", "relativeToReportId", "cursor", "limit",
	})
	if err != nil {
		return ReportListInput{}, err
	}
	var input ReportListInput
	if input.Query, err = object.optString("query"); err != nil {
		return ReportListInput{}, err
	}
	if input.Title, err = object.optString("title"); err != nil {
		return ReportListInput{}, err
	}
	if input.StartDate, err = object.optString("startDate"); err != nil {
		return ReportListInput{}, err
	}
	if input.EndDate, err = object.optString("endDate"); err != nil {
		return ReportListInput{}, err
	}
	if input.Statuses, err = object.optStringArray("statuses"); err != nil {
		return ReportListInput{}, err
	}
	if input.IncludeLegacy, err = object.optBool("includeLegacy"); err != nil {
		return ReportListInput{}, err
	}
	if input.Relation, err = object.optString("relation"); err != nil {
		return ReportListInput{}, err
	}
	if input.RelativeToReportID, err = object.optNumber("relativeToReportId"); err != nil {
		return ReportListInput{}, err
	}
	if input.Cursor, err = object.optString("cursor"); err != nil {
		return ReportListInput{}, err
	}
	if input.Limit, err = object.optNumber("limit"); err != nil {
		return ReportListInput{}, err
	}
	return input, nil
}

// ReportContentInput 是 query_report_content 的入参。
type ReportContentInput struct {
	ReportID     *float64
	Query        *string
	MaxMatches   *float64
	ContextLines *float64
	AllowStale   *bool
	AllowLegacy  *bool
}

// ParseReportContentInput 按 zod 的 strictObject 语义解析工具入参。
func ParseReportContentInput(data []byte) (ReportContentInput, error) {
	object, err := parseRawObject(data, []string{
		"reportId", "query", "maxMatches", "contextLines", "allowStale", "allowLegacy",
	})
	if err != nil {
		return ReportContentInput{}, err
	}
	var input ReportContentInput
	if input.ReportID, err = object.optNumber("reportId"); err != nil {
		return ReportContentInput{}, err
	}
	if input.Query, err = object.optString("query"); err != nil {
		return ReportContentInput{}, err
	}
	if input.MaxMatches, err = object.optNumber("maxMatches"); err != nil {
		return ReportContentInput{}, err
	}
	if input.ContextLines, err = object.optNumber("contextLines"); err != nil {
		return ReportContentInput{}, err
	}
	if input.AllowStale, err = object.optBool("allowStale"); err != nil {
		return ReportContentInput{}, err
	}
	if input.AllowLegacy, err = object.optBool("allowLegacy"); err != nil {
		return ReportContentInput{}, err
	}
	return input, nil
}
