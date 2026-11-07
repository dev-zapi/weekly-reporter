package reports

import (
	"encoding/json"
	"strings"
	"time"

	reportlib "github.com/dev-zapi/weekly-reporter/internal/reports"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件复刻 src/lib/validations.ts 里两个报告 schema（zod v4）在 HTTP 层可观测
// 的行为：哪些输入算合法、以及 400 分支里的 `details` 形状。
//
// route.ts 与 TS 的差别只有一处：`details: error` 在 NextResponse.json 里序列化
// 成 `{"name":"ZodError","message":"<issues 的 2 空格缩进 JSON>"}`（ZodError 的
// issues 是不可枚举属性，message 是 JSON.stringify(issues, null, 2)）。这里逐字段
// 复刻同一形状，issue 的键序也与 zod 一致。

const datePattern = `/^\d{4}-\d{2}-\d{2}$/`

// zodIssue 是 zod v4 issue 的 JSON 形状。字段顺序即序列化顺序：zod 对不同 code
// 输出的键集不同，omitempty 让同一个结构体覆盖全部形态。
type zodIssue struct {
	Expected  string   `json:"expected,omitempty"`
	Origin    string   `json:"origin,omitempty"`
	Code      string   `json:"code"`
	Format    string   `json:"format,omitempty"`
	Pattern   string   `json:"pattern,omitempty"`
	Minimum   *int     `json:"minimum,omitempty"`
	Maximum   *int     `json:"maximum,omitempty"`
	Inclusive *bool    `json:"inclusive,omitempty"`
	Path      []string `json:"path"`
	Message   string   `json:"message"`
}

// zodErrorDetails 是 ZodError 实例的 JSON 形状（name + message）。
type zodErrorDetails struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

// newZodErrorDetails 把 issue 列表折成 `details` 字段：message 是 2 空格缩进的
// issues JSON（ZodError 的 message getter 就是这样构造的）。
func newZodErrorDetails(issues []zodIssue) zodErrorDetails {
	message := "[]"
	if encoded, err := json.MarshalIndent(issues, "", "  "); err == nil {
		message = string(encoded)
	}
	return zodErrorDetails{Name: "ZodError", Message: message}
}

// receivedTypeName 复刻 zod 报错里的 received 名称。
//
// missing 用来区分「键不存在」（undefined）与「键存在但为 null」（null）。
func receivedTypeName(value any, missing bool) string {
	switch value.(type) {
	case nil:
		if missing {
			return "undefined"
		}
		return "null"
	case string:
		return "string"
	case float64, int64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "undefined"
}

func invalidTypeIssue(path []string, expected string, received any) zodIssue {
	return invalidTypeIssueWith(path, expected, received, false)
}

func invalidTypeIssueMissing(path []string, expected string) zodIssue {
	return invalidTypeIssueWith(path, expected, nil, true)
}

func invalidTypeIssueWith(path []string, expected string, received any, missing bool) zodIssue {
	return zodIssue{
		Expected: expected,
		Code:     "invalid_type",
		Path:     path,
		Message:  "Invalid input: expected " + expected + ", received " + receivedTypeName(received, missing),
	}
}

func invalidFormatIssue(path []string, pattern, message string) zodIssue {
	return zodIssue{
		Origin:  "string",
		Code:    "invalid_format",
		Format:  "regex",
		Pattern: pattern,
		Path:    path,
		Message: message,
	}
}

func tooSmallIssue(path []string, minimum int, message string) zodIssue {
	inclusive := true
	return zodIssue{
		Origin:    "string",
		Code:      "too_small",
		Minimum:   &minimum,
		Inclusive: &inclusive,
		Path:      path,
		Message:   message,
	}
}

func tooBigIssue(path []string, maximum int, message string) zodIssue {
	inclusive := true
	return zodIssue{
		Origin:    "string",
		Code:      "too_big",
		Maximum:   &maximum,
		Inclusive: &inclusive,
		Path:      path,
		Message:   message,
	}
}

func customIssue(path []string, message string) zodIssue {
	return zodIssue{Code: "custom", Path: path, Message: message}
}

const dateFormatMessage = "Date must use YYYY-MM-DD format"

// isDateString 复刻 DATE_REGEX：`^\d{4}-\d{2}-\d{2}$`（JS 的 \d 是 ASCII 数字）。
func isDateString(value string) bool {
	if len(value) != 10 {
		return false
	}
	for index := 0; index < len(value); index++ {
		switch index {
		case 4, 7:
			if value[index] != '-' {
				return false
			}
		default:
			if value[index] < '0' || value[index] > '9' {
				return false
			}
		}
	}
	return true
}

// compareWeekDates 复刻 `new Date(a) <= new Date(b)` 对 `YYYY-MM-DD` 的判定。
//
// ECMAScript 的 date-only 串按 UTC 解释；日历合法性规则由 jsdate 的严格解析器
// 给出（`2026-02-30` → Invalid Date，比较恒 false）。两个串在冻结契约里都已通过
// DATE_REGEX，因此不会出现其它形态。
func compareWeekDates(weekStart, weekEnd string) bool {
	start, startOK := dateOnlyMillis(weekStart)
	end, endOK := dateOnlyMillis(weekEnd)
	if !startOK || !endOK {
		return false
	}
	return start <= end
}

// dateOnlyMillis 把合法的 `YYYY-MM-DD` 折成 UTC 毫秒；非日历日期返回 ok=false。
func dateOnlyMillis(value string) (int64, bool) {
	year, month, day, ok := reportlib.ParseISODate(value)
	if !ok {
		return 0, false
	}
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).UnixMilli(), true
}

// reportWeekInput 是 reportWeekSchema.parse 之后的字段值。
type reportWeekInput struct {
	WeekStart string
	WeekEnd   string
}

// parseReportWeekBody 复刻 reportWeekSchema.parse 的成功/失败判定与 issue 列表。
func parseReportWeekBody(body any) (reportWeekInput, []zodIssue) {
	object, ok := body.(map[string]any)
	if !ok {
		return reportWeekInput{}, []zodIssue{invalidTypeIssue([]string{}, "object", body)}
	}

	var issues []zodIssue
	input := reportWeekInput{}
	values := map[string]*string{}
	for _, field := range []string{"weekStart", "weekEnd"} {
		value, present := object[field]
		if !present {
			issues = append(issues, invalidTypeIssueMissing([]string{field}, "string"))
			continue
		}
		text, isString := value.(string)
		if !isString {
			issues = append(issues, invalidTypeIssue([]string{field}, "string", value))
			continue
		}
		if !isDateString(text) {
			issues = append(issues, invalidFormatIssue([]string{field}, datePattern, dateFormatMessage))
			continue
		}
		copied := text
		values[field] = &copied
	}
	if len(issues) > 0 {
		return reportWeekInput{}, issues
	}

	input.WeekStart = *values["weekStart"]
	input.WeekEnd = *values["weekEnd"]
	// zod 只在基础对象校验全部通过后才跑 refine。
	if !compareWeekDates(input.WeekStart, input.WeekEnd) {
		return reportWeekInput{}, []zodIssue{customIssue([]string{"weekEnd"}, "Start date cannot be later than end date")}
	}
	return input, nil
}

// createReportInput 是 createReportSchema.parse 之后的字段值。
type createReportInput struct {
	Title     string
	WeekStart string
	WeekEnd   string
}

// parseCreateReportBody 复刻 createReportSchema.parse：
//
//	reportWeekSchema.safeExtend({ title: z.string().min(1).max(200) })
//
// issue 顺序与 zod 一致：字段定义顺序 weekStart → weekEnd → title；基础对象有
// 任何 issue 时 refine 不执行。
func parseCreateReportBody(body any) (createReportInput, []zodIssue) {
	object, ok := body.(map[string]any)
	if !ok {
		return createReportInput{}, []zodIssue{invalidTypeIssue([]string{}, "object", body)}
	}

	var issues []zodIssue
	input := createReportInput{}
	weekValues := map[string]string{}
	for _, field := range []string{"weekStart", "weekEnd"} {
		value, present := object[field]
		if !present {
			issues = append(issues, invalidTypeIssueMissing([]string{field}, "string"))
			continue
		}
		text, isString := value.(string)
		if !isString {
			issues = append(issues, invalidTypeIssue([]string{field}, "string", value))
			continue
		}
		if !isDateString(text) {
			issues = append(issues, invalidFormatIssue([]string{field}, datePattern, dateFormatMessage))
			continue
		}
		weekValues[field] = text
	}

	titleValue, titlePresent := object["title"]
	if !titlePresent {
		issues = append(issues, invalidTypeIssueMissing([]string{"title"}, "string"))
	} else if title, titleIsString := titleValue.(string); !titleIsString {
		issues = append(issues, invalidTypeIssue([]string{"title"}, "string", titleValue))
	} else {
		switch length := jsstr.UTF16Len(title); {
		case length < 1:
			issues = append(issues, tooSmallIssue([]string{"title"}, 1, "Title is required"))
		case length > 200:
			issues = append(issues, tooBigIssue([]string{"title"}, 200, "Title must be 200 characters or fewer"))
		default:
			input.Title = title
		}
	}

	if len(issues) > 0 {
		return createReportInput{}, issues
	}
	input.WeekStart = weekValues["weekStart"]
	input.WeekEnd = weekValues["weekEnd"]
	if !compareWeekDates(input.WeekStart, input.WeekEnd) {
		return createReportInput{}, []zodIssue{customIssue([]string{"weekEnd"}, "Start date cannot be later than end date")}
	}
	return input, nil
}

// trimJS 复刻 String.prototype.trim。
func trimJS(value string) string { return jsstr.Trim(value) }

// lowerJS 复刻 String.prototype.toLowerCase。
//
// Go 的 strings.ToLower 与 JS 的 Unicode 默认大小写映射只在少数特殊字母上不同
// （例如土耳其语 İ 的展开长度）；search 的两侧都走同一函数，因此匹配结果不受影响。
func lowerJS(value string) string { return strings.ToLower(value) }
