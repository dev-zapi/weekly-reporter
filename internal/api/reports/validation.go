package reports

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件复刻 src/lib/validations.ts 里两个报告 schema（zod v4）在 HTTP 层可观测
// 的行为：哪些输入算合法、以及 400 分支里的 `details` 形状。
//
// route.ts 与 TS 的差别只有一处：`details: error` 在 NextResponse.json 里序列化
// 成 `{"name":"ZodError","message":"<issues 的 2 空格缩进 JSON>"}`（ZodError 的
// issues 是不可枚举属性，message 是 JSON.stringify(issues, null, 2)）。这里逐字段
// 复刻同一形状，issue 的键序也与 zod 一致。

// datePattern 是 wire 上日期/周界参数的形状（RFC3339 带偏移）。date-only 不再
// 合法——服务器按请求自带偏移折算日历日，丢掉偏移就无法还原调用方的「那一天」。
const datePattern = `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/`

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

const dateFormatMessage = "Date must be an RFC3339 timestamp with an offset, e.g. 2026-11-03T00:00:00+08:00"

// parsedWeekInstant 是一个合法 wire 时刻的三种投影：
//   - key：按请求自带偏移折算出的日历日（周期键，仍存 date-only 文本）；
//   - location：请求偏移对应的固定时区，供事件窗口取整使用；
//   - instant：绝对时刻，仅用于 weekStart <= weekEnd 的比较。
type parsedWeekInstant struct {
	key      string
	location *time.Location
	instant  time.Time
}

// parseWeekInstant 用 time.Parse(RFC3339) 解析带偏移时刻，并显式拒绝 date-only
// 与 naive datetime（两者都解析失败）。日历日按请求偏移取整，不经过服务器时区。
func parseWeekInstant(value string) (parsedWeekInstant, bool) {
	instant, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return parsedWeekInstant{}, false
	}
	_, offset := instant.Zone()
	location := time.FixedZone("", offset)
	return parsedWeekInstant{
		key:      instant.In(location).Format("2006-01-02"),
		location: location,
		instant:  instant,
	}, true
}

// reportWeekInput 是 reportWeekSchema.parse 之后的字段值。WeekStart/WeekEnd 是
// 周期键（date-only），Location 是请求偏移，服务层据此取整日界。
type reportWeekInput struct {
	WeekStart     string
	WeekEnd       string
	StartLocation *time.Location
	EndLocation   *time.Location
}

// parseReportWeekBody 复刻 reportWeekSchema.parse 的成功/失败判定与 issue 列表。
func parseReportWeekBody(body any) (reportWeekInput, []zodIssue) {
	object, ok := body.(map[string]any)
	if !ok {
		return reportWeekInput{}, []zodIssue{invalidTypeIssue([]string{}, "object", body)}
	}

	var issues []zodIssue
	input := reportWeekInput{}
	values := map[string]parsedWeekInstant{}
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
		parsed, ok := parseWeekInstant(text)
		if !ok {
			issues = append(issues, invalidFormatIssue([]string{field}, datePattern, dateFormatMessage))
			continue
		}
		values[field] = parsed
	}
	if len(issues) > 0 {
		return reportWeekInput{}, issues
	}

	start, end := values["weekStart"], values["weekEnd"]
	input.WeekStart = start.key
	input.WeekEnd = end.key
	input.StartLocation = start.location
	input.EndLocation = end.location
	// zod 只在基础对象校验全部通过后才跑 refine。比较的是绝对时刻（旧 refine 的
	// `new Date(a) <= new Date(b)` 语义），不是折算后的日期键。
	if start.instant.After(end.instant) {
		return reportWeekInput{}, []zodIssue{customIssue([]string{"weekEnd"}, "Start date cannot be later than end date")}
	}
	return input, nil
}

// createReportInput 是 createReportSchema.parse 之后的字段值。
type createReportInput struct {
	Title         string
	WeekStart     string
	WeekEnd       string
	StartLocation *time.Location
	EndLocation   *time.Location
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
	weekValues := map[string]parsedWeekInstant{}
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
		parsed, ok := parseWeekInstant(text)
		if !ok {
			issues = append(issues, invalidFormatIssue([]string{field}, datePattern, dateFormatMessage))
			continue
		}
		weekValues[field] = parsed
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
	start, end := weekValues["weekStart"], weekValues["weekEnd"]
	input.WeekStart = start.key
	input.WeekEnd = end.key
	input.StartLocation = start.location
	input.EndLocation = end.location
	if start.instant.After(end.instant) {
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
