package reports_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 用例集逐条对照 src/app/api/reports/route.test.ts（ADR-0029：同用例集转 Go）。
// mock 层不再存在——这里用真实 SQLite（dbtest），断言的是同一批可观测输出。

func TestListReportsReturnsWeekFields(t *testing.T) {
	h := newHarness(t)
	// 列表按 created_at DESC 排序：后建的报告在前。
	h.seedReport("2024年第1周工作周报", "content-2", "2024-01-01", "2024-01-07", 1704704400)
	h.seedReport("2024年第2周工作周报", "content-1", "2024-01-08", "2024-01-14", 1705310800)

	rec := h.do(http.MethodGet, "/api/reports", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Reports []struct {
			ID        int64  `json:"id"`
			Title     string `json:"title"`
			WeekStart string `json:"weekStart"`
			WeekEnd   string `json:"weekEnd"`
			Variants  []any  `json:"variants"`
		} `json:"reports"`
		Total    int64 `json:"total"`
		Page     int64 `json:"page"`
		PageSize int64 `json:"pageSize"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}

	if len(body.Reports) != 2 {
		t.Fatalf("reports = %d, want 2", len(body.Reports))
	}
	if body.Reports[0].Title != "2024年第2周工作周报" || body.Reports[0].WeekStart != "2024-01-08" || body.Reports[0].WeekEnd != "2024-01-14" {
		t.Fatalf("first report = %+v", body.Reports[0])
	}
	if body.Reports[1].Title != "2024年第1周工作周报" || body.Reports[1].WeekStart != "2024-01-01" || body.Reports[1].WeekEnd != "2024-01-07" {
		t.Fatalf("second report = %+v", body.Reports[1])
	}
	if body.Total != 2 {
		t.Fatalf("total = %d, want 2", body.Total)
	}
	// 默认分页是 page=1 & pageSize=10。
	if body.Page != 1 || body.PageSize != 10 {
		t.Fatalf("page/pageSize = %d/%d, want 1/10", body.Page, body.PageSize)
	}
	// 没有变体行时 variants 是 []（不是 null）。
	if body.Reports[0].Variants == nil {
		t.Fatalf("variants is null, want []")
	}
}

func TestListReportsSupportsPagination(t *testing.T) {
	h := newHarness(t)
	for index := 0; index < 7; index++ {
		h.seedReport("report-"+itoa(int64(index)), "c", "2024-01-01", "2024-01-07", int64(1700000000+index))
	}

	rec := h.do(http.MethodGet, "/api/reports?page=2&pageSize=5", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Reports  []struct{ ID int64 } `json:"reports"`
		Page     int64                `json:"page"`
		PageSize int64                `json:"pageSize"`
		Total    int64                `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Page != 2 || body.PageSize != 5 {
		t.Fatalf("page/pageSize = %d/%d, want 2/5", body.Page, body.PageSize)
	}
	// offset=5，只剩 2 条。
	if len(body.Reports) != 2 {
		t.Fatalf("reports = %d, want 2", len(body.Reports))
	}
	if body.Total != 7 {
		t.Fatalf("total = %d, want 7", body.Total)
	}
}

func TestListReportsHandlesDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodGet, "/api/reports", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != "Failed to fetch reports" || body.Code != "FETCH_ERROR" {
		t.Fatalf("body = %+v", body)
	}
}

// GET 的 content 兼容字段取个人版终版，缺失时回退原稿（route.ts 的
// `personal?.finalContent ?? personal?.sourceDraft ?? report.content`）。
func TestListReportsPrefersPersonalFinalContent(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "legacy-content", "2024-01-08", "2024-01-14", 1705310800)
	h.seedVariant(reportID, "leadership", "- 领导版原稿", nil, 1, nil)
	final := "个人版终版"
	h.seedVariant(reportID, "personal", "- 个人版原稿", &final, 1, nil)

	rec := h.do(http.MethodGet, "/api/reports", "")
	var body struct {
		Reports []struct {
			Content  string `json:"content"`
			Variants []struct {
				Variant     string `json:"variant"`
				FinalStatus string `json:"finalStatus"`
			} `json:"variants"`
		} `json:"reports"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if len(body.Reports) != 1 {
		t.Fatalf("reports = %d, want 1", len(body.Reports))
	}
	if body.Reports[0].Content != final {
		t.Fatalf("content = %q, want %q", body.Reports[0].Content, final)
	}
	if len(body.Reports[0].Variants) != 2 {
		t.Fatalf("variants = %d, want 2", len(body.Reports[0].Variants))
	}
}

// POST 的 happy path：两个受众原稿 + 快照都落库，响应 201。
func TestCreateReportWritesBothVariantsAndSnapshots(t *testing.T) {
	h := newHarness(t)
	sourceID := h.seedCollectSource("work-repo", "work")
	h.seedEvent(1705000000, "manual", "手动重点", "")
	h.seedEvent(1705000001, "git-remote-github", "工作提交",
		`{"sourceId":`+itoa(sourceID)+`,"repo":"work-repo"}`)

	rec := h.do(http.MethodPost, "/api/reports",
		`{"title":"第2周周报","weekStart":"2024-01-08","weekEnd":"2024-01-14"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Report struct {
			ID      int64  `json:"id"`
			Title   string `json:"title"`
			Content string `json:"content"`
		} `json:"report"`
		Variants []struct {
			Variant      string  `json:"variant"`
			SourceDraft  string  `json:"sourceDraft"`
			FinalStatus  string  `json:"finalStatus"`
			FinalContent *string `json:"finalContent"`
		} `json:"variants"`
		Snapshots []struct {
			Content            string `json:"content"`
			LeadershipIncluded bool   `json:"leadershipIncluded"`
			PersonalIncluded   bool   `json:"personalIncluded"`
		} `json:"snapshots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}

	if body.Report.Title != "第2周周报" {
		t.Fatalf("title = %q", body.Report.Title)
	}
	if len(body.Variants) != 2 {
		t.Fatalf("variants = %d, want 2", len(body.Variants))
	}
	// 周报的 content 列保留个人版原稿（旧客户端仍读它）。
	if body.Report.Content != body.Variants[1].SourceDraft {
		t.Fatalf("report.content = %q, want personal draft %q", body.Report.Content, body.Variants[1].SourceDraft)
	}
	for _, variant := range body.Variants {
		if variant.FinalStatus != "none" || variant.FinalContent != nil {
			t.Fatalf("variant %s = %+v, want status none / no final", variant.Variant, variant)
		}
	}
	if len(body.Snapshots) != 2 {
		t.Fatalf("snapshots = %d, want 2", len(body.Snapshots))
	}
	// manual 事件两个受众都收；git 事件按 work scope 只进领导版。
	if !body.Snapshots[0].LeadershipIncluded || !body.Snapshots[0].PersonalIncluded {
		t.Fatalf("manual snapshot = %+v", body.Snapshots[0])
	}
	if !body.Snapshots[1].LeadershipIncluded || !body.Snapshots[1].PersonalIncluded {
		t.Fatalf("work snapshot = %+v", body.Snapshots[1])
	}
}

// POST 的 zod 失败形状：400 + VALIDATION_ERROR + ZodError details。
func TestCreateReportValidationShape(t *testing.T) {
	h := newHarness(t)

	cases := []struct {
		name     string
		body     string
		contains []string
	}{
		{
			name: "missing title",
			body: `{"weekStart":"2024-01-08","weekEnd":"2024-01-14"}`,
			contains: []string{
				`"error":"Validation failed"`,
				`"code":"VALIDATION_ERROR"`,
				`"name":"ZodError"`,
				`Invalid input: expected string, received undefined`,
				`\"title\"`,
			},
		},
		{
			name: "bad date format",
			body: `{"title":"x","weekStart":"2024-1-8","weekEnd":"2024-01-14"}`,
			contains: []string{
				`"error":"Validation failed"`,
				`\"origin\": \"string\"`,
				`\"code\": \"invalid_format\"`,
				`\"format\": \"regex\"`,
				`Date must use YYYY-MM-DD format`,
			},
		},
		{
			name:     "weekStart after weekEnd",
			body:     `{"title":"x","weekStart":"2024-01-20","weekEnd":"2024-01-14"}`,
			contains: []string{`\"code\": \"custom\"`, `Start date cannot be later than end date`},
		},
		{
			name:     "title too long",
			body:     `{"title":"` + repeat("a", 201) + `","weekStart":"2024-01-08","weekEnd":"2024-01-14"}`,
			contains: []string{`\"code\": \"too_big\"`, `Title must be 200 characters or fewer`},
		},
		{
			name:     "empty title",
			body:     `{"title":"","weekStart":"2024-01-08","weekEnd":"2024-01-14"}`,
			contains: []string{`\"code\": \"too_small\"`, `Title is required`},
		},
		{
			name:     "body is an array",
			body:     `[]`,
			contains: []string{`Invalid input: expected object, received array`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/reports", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			for _, want := range tc.contains {
				if !contains(rec.Body.String(), want) {
					t.Fatalf("body = %s, want it to contain %q", rec.Body.String(), want)
				}
			}
		})
	}
}

// 尾随垃圾让 request.json() 抛错 → 500 CREATE_ERROR（不是 400）。
func TestCreateReportRejectsTrailingGarbage(t *testing.T) {
	h := newHarness(t)
	rec := h.do(http.MethodPost, "/api/reports",
		`{"title":"x","weekStart":"2024-01-08","weekEnd":"2024-01-14"} trailing`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"CREATE_ERROR"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func repeat(value string, count int) string {
	out := ""
	for index := 0; index < count; index++ {
		out += value
	}
	return out
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}

// NaN 分页（parseInt 失败）在 drizzle 里是「丢掉 LIMIT/OFFSET 子句」：
// 查询仍执行、返回全部行，响应里的 page/pageSize 经 JSON.stringify 变成 null。
func TestListReportsNaNPageDropsClauses(t *testing.T) {
	h := newHarness(t)
	h.seedReport("a", "c", "2024-01-01", "2024-01-07", 1700000000)
	h.seedReport("b", "c", "2024-01-08", "2024-01-14", 1700000100)

	rec := h.do(http.MethodGet, "/api/reports?page=abc&pageSize=xyz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Reports  []any           `json:"reports"`
		Page     json.RawMessage `json:"page"`
		PageSize json.RawMessage `json:"pageSize"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Reports) != 2 {
		t.Fatalf("reports = %d, want all rows", len(body.Reports))
	}
	if string(body.Page) != "null" || string(body.PageSize) != "null" {
		t.Fatalf("page/pageSize = %s/%s, want null/null", body.Page, body.PageSize)
	}
}

// 超出 int64 的 LIMIT/OFFSET 在 better-sqlite3 里是 datatype mismatch → 500。
func TestListReportsUnbindablePageSize(t *testing.T) {
	h := newHarness(t)
	h.seedReport("a", "c", "2024-01-01", "2024-01-07", 1700000000)

	rec := h.do(http.MethodGet, "/api/reports?pageSize=99999999999999999999999", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"FETCH_ERROR"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// POST 的标题长度按 UTF-16 码元计（JS 的 string.length）。
func TestCreateReportCountsTitleInUTF16Units(t *testing.T) {
	h := newHarness(t)
	// 100 个增补平面字符 = 200 个 UTF-16 码元，恰好合法。
	title := repeat("😀", 100)
	rec := h.do(http.MethodPost, "/api/reports",
		`{"title":"`+title+`","weekStart":"2024-01-08","weekEnd":"2024-01-14"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}

	// 101 个 = 202 个码元 → 超限。
	rec = h.do(http.MethodPost, "/api/reports",
		`{"title":"`+repeat("😀", 101)+`","weekStart":"2024-01-08","weekEnd":"2024-01-14"}`)
	if rec.Code != http.StatusBadRequest || !contains(rec.Body.String(), `\"code\": \"too_big\"`) {
		t.Fatalf("status = %d, want 400 too_big (body %s)", rec.Code, rec.Body.String())
	}
}
