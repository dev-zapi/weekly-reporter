package reports

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	reportlib "github.com/dev-zapi/weekly-reporter/internal/reports"
)

// 本文件覆盖 /api/reports 的列表、新建、搜索、预览，以及 /api/reports/{id} 的
// 读改删与 regenerate-source。逐条对照 src/app/api/reports 下对应的 route.ts。

// validationsError 是 zod 失败时的 400 形状（details 是序列化后的 ZodError）。
type validationsError struct {
	Error   string          `json:"error"`
	Code    string          `json:"code"`
	Details zodErrorDetails `json:"details"`
}

func respondValidationDetails(w http.ResponseWriter, issues []zodIssue) {
	respond.JSON(w, http.StatusBadRequest, validationsError{
		Error:   "Validation failed",
		Code:    "VALIDATION_ERROR",
		Details: newZodErrorDetails(issues),
	})
}

// parseReportID 复刻 `Number.parseInt(params.id, 10)`；NaN 时 ok=false。
func parseReportID(r *http.Request) (int64, bool) {
	return jsparse.ParseInt10(chi.URLParam(r, "id"))
}

func parseSessionID(r *http.Request) (int64, bool) {
	return jsparse.ParseInt10(chi.URLParam(r, "sessionId"))
}

// ---- GET /api/reports ----

// reportListItem 是列表的一行：报告字段 + content 覆盖 + variants。
type reportListItem struct {
	reportlib.ReportJSON
	Content  string                  `json:"content"`
	Variants []reportlib.VariantJSON `json:"variants"`
}

func listReportsHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		page := jsMax(1, parseQueryInt(query.Get("page"), "1"))
		pageSize := jsMax(1, parseQueryInt(query.Get("pageSize"), "10"))
		offset := jsMultiply(page-1, pageSize)

		limitParam, limitOK := bindLimit(pageSize)
		offsetParam, offsetOK := bindOffset(offset)
		if !limitOK || !offsetOK {
			// better-sqlite3 把超出 int64 的 LIMIT/OFFSET 绑成 REAL → datatype
			// mismatch → route.ts 的 catch 是 500 FETCH_ERROR。
			log.Printf("GET /api/reports error: unbindable page=%v pageSize=%v", page, pageSize)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch reports", "FETCH_ERROR")
			return
		}

		pageRows, err := deps.Queries.ListReportsForReportRoutes(r.Context(), db.ListReportsForReportRoutesParams{
			Limit:  limitParam,
			Offset: offsetParam,
		})
		if err != nil {
			log.Printf("GET /api/reports error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch reports", "FETCH_ERROR")
			return
		}

		// route.ts 只在当前页非空时才查询变体表，且查询不带 WHERE（全表）。
		variantRows := []db.ListReportVariantsForReportRoutesRow{}
		if len(pageRows) > 0 {
			variantRows, err = deps.Queries.ListReportVariantsForReportRoutes(r.Context(), db.ListReportVariantsForReportRoutesParams{
				IDFilter:     int64(0),
				ReportFilter: int64(0),
			})
			if err != nil {
				// route.ts 用 try/catch 吞掉变体查询错误（兼容旧 adapter）。
				log.Printf("GET /api/reports variants error: %v", err)
				variantRows = []db.ListReportVariantsForReportRoutesRow{}
			}
		}

		variantsByReport := make(map[int64][]reportlib.VariantJSON, len(variantRows))
		for _, variant := range reportlib.VariantsToJSON(variantRows) {
			variantsByReport[variant.ReportID] = append(variantsByReport[variant.ReportID], variant)
		}

		items := make([]reportListItem, 0, len(pageRows))
		for _, row := range pageRows {
			report := reportlib.ReportToJSON(row)
			variants := variantsByReport[row.ID]
			if variants == nil {
				variants = []reportlib.VariantJSON{}
			}
			content := report.Content
			for _, variant := range variants {
				if variant.Variant != "personal" {
					continue
				}
				if variant.FinalContent != nil {
					content = *variant.FinalContent
				} else {
					// `?? ` 只跳过 null/undefined：sourceDraft 是 NOT NULL 列，
					// 空串也会覆盖 report.content。
					content = variant.SourceDraft
				}
				break
			}
			items = append(items, reportListItem{ReportJSON: report, Content: content, Variants: variants})
		}

		// total 走全表 COUNT；route.ts 的错误兜底是 allReports.length，但真实库上
		// 两次查询共享同一连接，前一查询成功时这里不会单独失败。
		total, err := deps.Queries.CountReportsForReportRoutes(r.Context())
		if err != nil {
			log.Printf("GET /api/reports count error: %v", err)
			total = int64(len(pageRows))
		}

		respond.JSON(w, http.StatusOK, struct {
			Reports  []reportListItem `json:"reports"`
			Total    int64            `json:"total"`
			Page     any              `json:"page"`
			PageSize any              `json:"pageSize"`
		}{
			Reports:  items,
			Total:    total,
			Page:     jsNumberOrNull(page),
			PageSize: jsNumberOrNull(pageSize),
		})
	}
}

// parseQueryInt 复刻 `Number.parseInt(sp.get(x) || fallback, 10)`：空串/缺省走
// fallback；解析失败是 NaN；成功返回 JS 的 double 结果（可能超出 int64）。
func parseQueryInt(raw, fallback string) float64 {
	if raw == "" {
		raw = fallback
	}
	return parseJSIntDouble(raw)
}

// parseJSIntDouble 复刻 `Number.parseInt(s, 10)` 的 double 结果。
//
// 与 jsparse 的差别：radix 固定 10（`0x10` 解析成 0，不是 16），且结果按 double
// 累积——超出 int64 的值保持为 finite double（再大的数字串会到 ±Infinity），
// 绑进 LIMIT/OFFSET 就是 datatype mismatch（500），不能饱和成 MaxInt64。
func parseJSIntDouble(raw string) float64 {
	index := 0
	for index < len(raw) {
		r, size := utf8.DecodeRuneInString(raw[index:])
		if !jsstr.IsSpace(r) {
			break
		}
		index += size
	}

	negative := false
	if index < len(raw) && (raw[index] == '+' || raw[index] == '-') {
		negative = raw[index] == '-'
		index++
	}

	start := index
	for index < len(raw) && raw[index] >= '0' && raw[index] <= '9' {
		index++
	}
	if index == start {
		return math.NaN()
	}

	// parseInt 的规范是先求和再一次性舍入成 double，所以这里把数字前缀交给
	// ParseFloat（同样一次正确舍入），而不是逐位 float 累加。超长数字串得到
	// ±Infinity，与 JS 一致。
	digits := raw[start:index]
	if negative {
		digits = "-" + digits
	}
	value, err := strconv.ParseFloat(digits, 64)
	if err != nil {
		// 只有 ErrRange（溢出成 ±Inf）会走到这里，ParseFloat 仍返回该值。
		if !math.IsInf(value, 0) {
			return math.NaN()
		}
	}
	return value
}

func jsMax(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	if a >= b {
		return a
	}
	return b
}

func jsMultiply(a, b float64) float64 { return a * b }

// bindLimit 复刻 drizzle 的 LIMIT 处理（buildLimit）：
//   - NaN → `typeof limit === 'number' && limit >= 0` 为假，子句被丢掉。SQLite 的
//     `LIMIT -1` 是同一语义（无上界）；
//   - 超 int64 的值 → better-sqlite3 把 REAL 绑进 LIMIT → datatype mismatch（500）。
func bindLimit(value float64) (int64, bool) {
	if math.IsNaN(value) {
		return -1, true
	}
	return bindInteger(value)
}

// bindOffset 复刻 drizzle 的 OFFSET 处理：`offset ? sql`offset ${offset}` : void 0`，
// 所以 0 与 NaN 都是「没有 OFFSET 子句」。
func bindOffset(value float64) (int64, bool) {
	if math.IsNaN(value) || value == 0 {
		return 0, true
	}
	return bindInteger(value)
}

func bindInteger(value float64) (int64, bool) {
	if math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	if value >= 9223372036854775808.0 || value < -9223372036854775808.0 {
		return 0, false
	}
	return int64(value), true
}

// jsNumberOrNull 复刻 JSON.stringify(number)：NaN / ±Infinity 输出 null。
func jsNumberOrNull(value float64) any {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return json.RawMessage("null")
	}
	return json.RawMessage(jsnum.FormatNumber(value))
}

// ---- POST /api/reports ----

func createReportHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			// route.ts 里 request.json() 抛错落进 catch：不是 ZodError → 500。
			log.Printf("POST /api/reports error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create report", "CREATE_ERROR")
			return
		}

		input, issues := parseCreateReportBody(body)
		if len(issues) > 0 {
			respondValidationDetails(w, issues)
			return
		}

		created, err := reportlib.CreateReportWithSourceDrafts(r.Context(), deps.Queries, reportlib.CreateReportInput{
			Title:         input.Title,
			WeekStart:     input.WeekStart,
			WeekEnd:       input.WeekEnd,
			StartLocation: input.StartLocation,
			EndLocation:   input.EndLocation,
		}, nowUnix())
		if err != nil {
			log.Printf("POST /api/reports error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create report", "CREATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, struct {
			Report    reportlib.ReportJSON     `json:"report"`
			Variants  []reportlib.VariantJSON  `json:"variants"`
			Snapshots []reportlib.SnapshotJSON `json:"snapshots"`
		}{Report: created.Report, Variants: created.Variants, Snapshots: created.Snapshots})
	}
}

// ---- POST /api/reports/preview ----

func previewHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("POST /api/reports/preview error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to preview source draft", "PREVIEW_ERROR")
			return
		}

		input, issues := parseReportWeekBody(body)
		if len(issues) > 0 {
			respondValidationDetails(w, issues)
			return
		}

		variants, err := reportlib.PreviewReportSourceDrafts(r.Context(), deps.Queries, input.WeekStart, input.WeekEnd, input.StartLocation, input.EndLocation)
		if err != nil {
			log.Printf("POST /api/reports/preview error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to preview source draft", "PREVIEW_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			Variants []reportlib.PreviewVariant `json:"variants"`
		}{Variants: variants})
	}
}

// ---- GET /api/reports/search ----

type searchResultItem struct {
	reportlib.ReportJSON
	Variants []reportlib.VariantJSON `json:"variants"`
}

// searchDateKey 把一个搜索日期参数折算成 date-only 周期键。
//
// 空串表示未过滤（ok=true）。非空时必须能按请求偏移折出日历日——date-only 与
// naive datetime 都会被 time.Parse(RFC3339) 拒绝，调用方据此回 400。
func searchDateKey(raw string) (key string, ok bool) {
	if raw == "" {
		return "", true
	}
	parsed, ok := parseWeekInstant(raw)
	if !ok {
		return "", false
	}
	return parsed.key, true
}

func searchHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		searchQuery := lowerJS(trimJS(query.Get("q")))
		startDate, startOK := searchDateKey(query.Get("startDate"))
		if !startOK {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{
				Error: "startDate must be an RFC3339 timestamp with an offset, e.g. 2026-11-03T00:00:00+08:00",
			})
			return
		}
		endDate, endOK := searchDateKey(query.Get("endDate"))
		if !endOK {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{
				Error: "endDate must be an RFC3339 timestamp with an offset, e.g. 2026-11-09T00:00:00+08:00",
			})
			return
		}

		reportRows, err := deps.Queries.ListReportsForReportRoutes(r.Context(), db.ListReportsForReportRoutesParams{
			Limit:  -1,
			Offset: 0,
		})
		if err != nil {
			log.Printf("GET /api/reports/search error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Search failed", "SEARCH_ERROR")
			return
		}
		variantRows, err := deps.Queries.ListReportVariantsForReportRoutes(r.Context(), db.ListReportVariantsForReportRoutesParams{
			IDFilter:     int64(0),
			ReportFilter: int64(0),
		})
		if err != nil {
			log.Printf("GET /api/reports/search error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Search failed", "SEARCH_ERROR")
			return
		}
		variantsByReport := make(map[int64][]reportlib.VariantJSON, len(variantRows))
		for _, variant := range reportlib.VariantsToJSON(variantRows) {
			variantsByReport[variant.ReportID] = append(variantsByReport[variant.ReportID], variant)
		}

		results := make([]searchResultItem, 0, len(reportRows))
		for _, row := range reportRows {
			report := reportlib.ReportToJSON(row)
			// 日期过滤是字符串比较（`report.weekStart < startDate`）。
			if startDate != "" && report.WeekStart < startDate {
				continue
			}
			if endDate != "" && report.WeekEnd > endDate {
				continue
			}
			variants := variantsByReport[row.ID]
			if variants == nil {
				variants = []reportlib.VariantJSON{}
			}
			if searchQuery != "" {
				// `[title, content, ...variants.flatMap(v => [v.sourceDraft, v.finalContent ?? ''])]
				//   .join('\n').toLowerCase()`：finalContent 为 null 时仍占一个空元素。
				parts := make([]string, 0, 2+2*len(variants))
				parts = append(parts, report.Title, report.Content)
				for _, variant := range variants {
					parts = append(parts, variant.SourceDraft)
					if variant.FinalContent != nil {
						parts = append(parts, *variant.FinalContent)
					} else {
						parts = append(parts, "")
					}
				}
				if !containsFold(strings.Join(parts, "\n"), searchQuery) {
					continue
				}
			}
			results = append(results, searchResultItem{ReportJSON: report, Variants: variants})
		}

		respond.JSON(w, http.StatusOK, struct {
			Reports []searchResultItem `json:"reports"`
		}{Reports: results})
	}
}

// containsFold 复刻 `text.toLowerCase().includes(query)`（query 已 lowercase）。
func containsFold(text, lowerQuery string) bool {
	return indexOfLower(lowerJS(text), lowerQuery) >= 0
}

func indexOfLower(haystack, needle string) int {
	if needle == "" {
		return 0
	}
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}

// ---- GET /api/reports/{id} ----

// legacyVariant 是变体表为空时伪造的个人版变体（route.ts 的兼容分支）。
func legacyVariant(report reportlib.ReportJSON) reportlib.VariantJSON {
	return reportlib.VariantJSON{
		ID:                        -report.ID,
		ReportID:                  report.ID,
		Variant:                   "personal",
		SourceDraft:               reportlib.EmptySourceDraft,
		FinalContent:              &report.Content,
		FinalStatus:               "current",
		TemplateID:                nil,
		TemplateName:              nil,
		TemplateContent:           nil,
		StructureCompletenessRule: json.RawMessage("null"),
		AiStyle:                   report.AiStyleOverride,
		AcceptedProposalID:        nil,
		SourceRevision:            0,
		CreatedAt:                 report.CreatedAt,
		UpdatedAt:                 report.UpdatedAt,
	}
}

func getReportHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		bundle, err := reportlib.GetReportBundle(r.Context(), deps.Queries, reportID)
		if err != nil {
			log.Printf("GET /api/reports/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to fetch report", "FETCH_ERROR")
			return
		}
		if bundle == nil {
			respond.Error(w, http.StatusNotFound, "Report not found", "NOT_FOUND")
			return
		}

		variants := bundle.Variants
		if len(variants) == 0 {
			variants = []reportlib.VariantJSON{legacyVariant(bundle.Report)}
		}
		content := bundle.Report.Content
		for _, variant := range variants {
			if variant.Variant != "personal" {
				continue
			}
			if variant.FinalContent != nil {
				content = *variant.FinalContent
			} else {
				content = variant.SourceDraft
			}
			break
		}

		response := bundleFrom(bundle)
		// route.ts 在变体表为空时用伪造的个人版变体替换 variants。
		response.Variants = variants
		respond.JSON(w, http.StatusOK, struct {
			reportBundleJSON
			Content string `json:"content"`
		}{reportBundleJSON: response, Content: content})
	}
}

// ---- PUT /api/reports/{id} ----

func updateReportHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to update report", "UPDATE_ERROR")
			return
		}

		existing, err := deps.Queries.GetReportForReportRoutes(r.Context(), reportID)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Report not found", "NOT_FOUND")
			return
		}
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to update report", "UPDATE_ERROR")
			return
		}

		title := existing.Title
		object, isObject := body.(map[string]any)
		if !isObject {
			// `typeof body.title === 'string'`：null/数组/原始值都让 route.ts 抛
			// TypeError（null）或回落到原值（其余）——统一按「保持原标题」处理。
			if body == nil {
				respond.Error(w, http.StatusInternalServerError, "Failed to update report", "UPDATE_ERROR")
				return
			}
		} else if value, present := object["title"]; present {
			if text, isString := value.(string); isString && trimJS(text) != "" {
				title = trimJS(text)
			}
		}

		updated, err := deps.Queries.UpdateReportTitleForReportRoutes(r.Context(), db.UpdateReportTitleForReportRoutesParams{
			Title:     title,
			UpdatedAt: nowUnix(),
			ID:        reportID,
		})
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to update report", "UPDATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, reportlib.ReportToJSON(updated))
	}
}

// ---- DELETE /api/reports/{id} ----

// auditRecordRequiredMessage 是 route.ts 里 409 的固定文案。
const auditRecordRequiredMessage = "This report contains generation audit records for an accepted final version. Keep the report or archive its sessions first."

func deleteReportHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		_, err := deps.Queries.GetReportForReportRoutes(r.Context(), reportID)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Report not found", "NOT_FOUND")
			return
		}
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to delete report", "DELETE_ERROR")
			return
		}

		if _, err := deps.Queries.GetAcceptedGenerationProposalIDForReportRoutes(r.Context(), reportID); err == nil {
			respond.Error(w, http.StatusConflict, auditRecordRequiredMessage, "AUDIT_RECORD_REQUIRED")
			return
		} else if !errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusInternalServerError, "Failed to delete report", "DELETE_ERROR")
			return
		}

		err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
			ctx := r.Context()
			if err := tx.DeleteGenerationProposalsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteGenerationPlanJudgmentsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteGenerationPlanOverridesByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteGenerationMessagePartsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteGenerationTurnsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteGenerationSessionsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteReportSnapshotsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			if err := tx.DeleteReportVariantsByReportForReportRoutes(ctx, reportID); err != nil {
				return err
			}
			return tx.DeleteReportForReportRoutes(ctx, reportID)
		})
		if err != nil {
			log.Printf("DELETE /api/reports/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete report", "DELETE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			Success bool `json:"success"`
		}{Success: true})
	}
}

// ---- POST /api/reports/{id}/regenerate-source ----

func regenerateSourceHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		bundle, err := reportlib.RegenerateSourceDrafts(r.Context(), deps.Queries, reportID, nowUnix())
		if err != nil {
			log.Printf("POST /api/reports/[id]/regenerate-source error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to regenerate source draft", "REGENERATE_ERROR")
			return
		}
		if bundle == nil {
			respond.Error(w, http.StatusNotFound, "Report not found", "NOT_FOUND")
			return
		}
		respond.JSON(w, http.StatusOK, bundleFrom(bundle))
	}
}

// reportBundleJSON 是 getReportBundle 的响应形状（GET /reports/{id} 与
// regenerate-source 共用）。
type reportBundleJSON struct {
	reportlib.ReportJSON
	Variants  []reportlib.VariantJSON  `json:"variants"`
	Snapshots []reportlib.SnapshotJSON `json:"snapshots"`
}

func bundleFrom(bundle *reportlib.ReportBundle) reportBundleJSON {
	return reportBundleJSON{ReportJSON: bundle.Report, Variants: bundle.Variants, Snapshots: bundle.Snapshots}
}

// nowUnix 是 `new Date()` 落库后的 Unix 秒。
func nowUnix() int64 { return timeNow().Unix() }

// timeNow 单独提出来，测试可以替换（当前实现就是 time.Now）。
var timeNow = func() time.Time { return time.Now() }
