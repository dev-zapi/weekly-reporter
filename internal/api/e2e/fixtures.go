// Package e2e 把 e2e 造数路由（`/api/e2e/fixtures`）挂到 chi 的 /api 子路由上。
//
// 原样移植 src/app/api/e2e/fixtures/route.ts（ADR-0029）：同路径、同
// `{action, marker, …}` 请求/响应形状、`E2E_FIXTURES=1` 门控、withAuth 语义
// （由 /api 中间件统一提供）、`database/sql` 直写 DB、DELETE 清理同形。
//
// 这是全套 e2e 的造数底座：action=historical 造「历史报告」三态
// （current/stale/legacy），action=report-query 围绕一个目标报告造出 report-list
// 工具所需的相邻/同受众/跨受众/长内容/legacy 等语料。响应形状被
// e2e/historical-fixtures.ts 与 e2e/report-list-tool.spec.ts 直接消费。
package e2e

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把 e2e 造数路由注册到 /api 子路由上。
//
//	POST   /e2e/fixtures
//	DELETE /e2e/fixtures
func Mount(r chi.Router, deps Deps) {
	r.Post("/e2e/fixtures", postHandler(deps))
	r.Delete("/e2e/fixtures", deleteHandler(deps))
}

// enabled 复刻 route.ts 的 `enabled()`：每次请求读一次 E2E_FIXTURES，严格等于 "1"。
// 放在 handler 里而不是启动时读，是为了让 httptest 能用 t.Setenv 逐用例切换门控。
func enabled() bool { return os.Getenv("E2E_FIXTURES") == "1" }

// writeDisabled 是门控关闭时的响应：与 route.ts 一样是 404 + {error:"Not found"}
// （注意大小写，与带 code 的业务错误不同）。
func writeDisabled(w http.ResponseWriter) {
	respond.JSON(w, http.StatusNotFound, respond.ErrorBody{Error: "Not found"})
}

// writeUnhandled 复刻 route.ts 未捕获异常的落点：两个 handler 都没有 try/catch，
// 异常越过 withAuth 交给 Next 的默认 500（body 不是本路由的 JSON 契约）。这里保留
// 500 状态码，body 用与 settings/models.go 相同的通用错误体——该分支不在任何冻结
// 的响应契约里。
func writeUnhandled(w http.ResponseWriter, action string, cause error) {
	log.Printf("e2e fixtures %s error: %v", action, cause)
	respond.JSON(w, http.StatusInternalServerError, respond.ErrorBody{Error: "Internal Server Error"})
}

// postHandler 复刻 POST /api/e2e/fixtures。
func postHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !enabled() {
			writeDisabled(w)
			return
		}

		// `await request.json().catch(() => null)`：解析失败等价于 body=null，
		// 与「body 不是对象」一起落进下面的 INVALID_INPUT 分支。
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			body = nil
		}
		object, _ := body.(map[string]any)

		action, _ := object["action"].(string)
		markerValue, markerIsString := object["marker"].(string)
		if (action != "historical" && action != "report-query") || !markerIsString || jsstr.Trim(markerValue) == "" {
			respond.Error(w, http.StatusBadRequest, "A marker and historical action are required", "INVALID_INPUT")
			return
		}

		// `body.marker.trim().slice(0, 120)`：先按 JS trim，再按 UTF-16 码元截断。
		marker := jsstr.SliceUTF16(jsstr.Trim(markerValue), 120)
		// `const now = new Date()` 只取一次，所有行共用同一个时间戳（drizzle 的
		// timestamp 模式存 Unix 秒）。
		now := time.Now().Unix()

		if action == "report-query" {
			serveReportQuery(w, r.Context(), deps.Queries, object, marker, now)
			return
		}
		serveHistorical(w, r.Context(), deps.Queries, marker, now)
	}
}

// deleteHandler 复刻 DELETE /api/e2e/fixtures。
func deleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !enabled() {
			writeDisabled(w)
			return
		}

		// 清理请求同样没有 try/catch：request.json() 抛错会被外层的
		// `.catch(() => null)` 吃掉，body 变 null，两个 id 列表都为空 → {deleted:0}。
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			body = nil
		}
		object, _ := body.(map[string]any)

		reportIDs, reportCount := positiveIntegerList(object["reportIds"])
		eventIDs, eventCount := positiveIntegerList(object["eventIds"])
		if reportCount == 0 && eventCount == 0 {
			respond.JSON(w, http.StatusOK, deletedBody{Deleted: 0})
			return
		}

		err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
			if len(reportIDs) > 0 {
				sessions, err := tx.ListGenerationSessionIDsForFixtures(r.Context(), reportIDs)
				if err != nil {
					return err
				}
				for _, session := range sessions {
					if err := tx.DeleteGenerationProposalsForFixtures(r.Context(), session); err != nil {
						return err
					}
					if err := tx.DeleteGenerationPlanJudgmentsForFixtures(r.Context(), session); err != nil {
						return err
					}
					if err := tx.DeleteGenerationPlanOverridesForFixtures(r.Context(), session); err != nil {
						return err
					}
					if err := tx.DeleteGenerationMessagePartsForFixtures(r.Context(), session); err != nil {
						return err
					}
					if err := tx.DeleteGenerationTurnsForFixtures(r.Context(), session); err != nil {
						return err
					}
				}
				if err := tx.DeleteGenerationSessionsForFixtures(r.Context(), reportIDs); err != nil {
					return err
				}
				if err := tx.DeleteReportEventSnapshotsForFixtures(r.Context(), reportIDs); err != nil {
					return err
				}
				if err := tx.DeleteReportVariantsForFixtures(r.Context(), reportIDs); err != nil {
					return err
				}
				if err := tx.DeleteReportsForFixtures(r.Context(), reportIDs); err != nil {
					return err
				}
			}
			if len(eventIDs) > 0 {
				if err := tx.DeleteRawEventsForFixtures(r.Context(), eventIDs); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			writeUnhandled(w, "DELETE", err)
			return
		}

		// route.ts 回的是「请求里通过校验的 id 个数」，不是实际删除行数。
		respond.JSON(w, http.StatusOK, deletedBody{Deleted: reportCount + eventCount})
	}
}

// deletedBody 是 DELETE 的响应形状。
type deletedBody struct {
	Deleted int `json:"deleted"`
}

// serveHistorical 复刻 action=historical：current/stale/legacy 三态各一条报告，
// 前两条各带 leadership/personal 两个终版，legacy 只有正文（读取路径回落到
// reports.content）。
func serveHistorical(w http.ResponseWriter, ctx context.Context, q *db.Queries, marker string, now int64) {
	moderns := []struct {
		kind      string
		weekStart string
		weekEnd   string
	}{
		{kind: "current", weekStart: "2026-12-21", weekEnd: "2026-12-27"},
		{kind: "stale", weekStart: "2026-12-14", weekEnd: "2026-12-20"},
	}

	// 元素形状是 {id, kind}；e2e/historical-fixtures.ts 按此消费。
	type historicalReport struct {
		ID   int64  `json:"id"`
		Kind string `json:"kind"`
	}
	rows := make([]historicalReport, 0, 3)

	for _, item := range moderns {
		reportID, err := insertReport(ctx, q, db.InsertReportParams{
			Title:     marker + " " + item.kind + " history",
			Content:   "# " + item.kind + " history",
			WeekStart: item.weekStart,
			WeekEnd:   item.weekEnd,
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			writeUnhandled(w, "POST", err)
			return
		}
		for _, variant := range []string{"leadership", "personal"} {
			if err := q.InsertReportVariantForFixtures(ctx, db.InsertReportVariantForFixturesParams{
				ReportID:       reportID,
				Variant:        variant,
				SourceDraft:    "- " + marker + " " + variant + " source",
				FinalContent:   stringPtr("# " + marker + " " + variant + " final"),
				FinalStatus:    item.kind,
				SourceRevision: 1,
				CreatedAt:      now,
				UpdatedAt:      now,
			}); err != nil {
				writeUnhandled(w, "POST", err)
				return
			}
		}
		rows = append(rows, historicalReport{ID: reportID, Kind: item.kind})
	}

	legacyID, err := insertReport(ctx, q, db.InsertReportParams{
		Title:     marker + " legacy history",
		Content:   "# " + marker + " legacy final",
		WeekStart: "2026-12-07",
		WeekEnd:   "2026-12-13",
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeUnhandled(w, "POST", err)
		return
	}
	rows = append(rows, historicalReport{ID: legacyID, Kind: "legacy"})

	respond.JSON(w, http.StatusCreated, struct {
		Reports []historicalReport `json:"reports"`
	}{Reports: rows})
}

// variantInput 是 report-query 语料里一个 variant 的期望形态。
type variantInput struct {
	audience     string
	finalStatus  string
	finalContent *string
	accepted     bool
}

// reportQueryBody 是 action=report-query 的响应形状。键序照 route.ts 的对象字面量；
// mode=no-adjacent 时 adjacentReportId 在 JS 侧是 undefined（JSON.stringify 丢键），
// 这里用指针 + omitempty 对齐。
type reportQueryBody struct {
	ReportIDs             []int64 `json:"reportIds"`
	AdjacentReportID      *int64  `json:"adjacentReportId,omitempty"`
	SameAudienceReportID  int64   `json:"sameAudienceReportId"`
	CrossAudienceReportID int64   `json:"crossAudienceReportId"`
	LongReportID          int64   `json:"longReportId"`
	CurrentLegacyReportID int64   `json:"currentLegacyReportId"`
	StaleReportID         int64   `json:"staleReportId"`
	LegacyReportID        int64   `json:"legacyReportId"`
	NoneReportID          int64   `json:"noneReportId"`
	UnacceptedReportID    int64   `json:"unacceptedReportId"`
}

// serveReportQuery 复刻 action=report-query。所有相对周都按目标报告 weekStart 的
// 本地日历日平移（date-fns 的 parseISO + subDays + format 三者都是本地日历语义）。
func serveReportQuery(w http.ResponseWriter, ctx context.Context, q *db.Queries, object map[string]any, marker string, now int64) {
	targetValue, _ := object["targetReportId"].(float64)
	if !isIntegerNumber(targetValue) || targetValue <= 0 {
		respond.Error(w, http.StatusBadRequest, "A target report ID is required", "INVALID_INPUT")
		return
	}
	// 超出 int64 的 JS 整数（Number.isInteger(1e20) 为真）不可能是任何报告的 id：
	// drizzle 按 REAL 绑定后查不到行，落进同一个 404 分支。
	if targetValue >= math.MaxInt64 {
		respond.Error(w, http.StatusNotFound, "Target report not found", "REPORT_NOT_FOUND")
		return
	}
	targetReportID := int64(targetValue)

	weekStart, err := q.GetReportWeekStartForFixtures(ctx, targetReportID)
	if errors.Is(err, sql.ErrNoRows) {
		respond.Error(w, http.StatusNotFound, "Target report not found", "REPORT_NOT_FOUND")
		return
	}
	if err != nil {
		writeUnhandled(w, "POST", err)
		return
	}

	targetStart, ok := parseISODate(weekStart)
	if !ok {
		// date-fns 的 format(Invalid Date) 抛 RangeError；route.ts 没有 catch，
		// 由 Next 转 500。保留 500 状态码与通用错误体。
		writeUnhandled(w, "POST", errors.New("invalid target week_start: "+weekStart))
		return
	}

	// createReport 复刻 route.ts 的闭包：插报告 + 按数组顺序插 variants，accepted
	// 的 variant 拿 `report.id*100 + index + 1` 作为 proposal id。
	// 返回 false 表示已写出错误响应（route.ts 对应的是异常冒泡）。
	reportIDs := make([]int64, 0, 9)
	createReport := func(title string, startOffset, endOffset int, variants []variantInput) (int64, bool) {
		reportID, err := insertReport(ctx, q, db.InsertReportParams{
			Title:   title,
			Content: "# raw source must stay private: " + title,
			// 相对周按目标报告的 weekStart 平移：`subDays(parseISO(weekStart), n)`。
			WeekStart: formatLocalDay(subDays(targetStart, startOffset)),
			WeekEnd:   formatLocalDay(subDays(targetStart, endOffset)),
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			writeUnhandled(w, "POST", err)
			return 0, false
		}
		for index, variant := range variants {
			var acceptedProposalID *int64
			if variant.accepted {
				id := reportID*100 + int64(index) + 1
				acceptedProposalID = &id
			}
			if err := q.InsertReportVariantForFixtures(ctx, db.InsertReportVariantForFixturesParams{
				ReportID:           reportID,
				Variant:            variant.audience,
				SourceDraft:        "- private " + variant.audience + " source draft for " + title,
				FinalContent:       variant.finalContent,
				FinalStatus:        variant.finalStatus,
				AcceptedProposalID: acceptedProposalID,
				SourceRevision:     1,
				CreatedAt:          now,
				UpdatedAt:          now,
			}); err != nil {
				writeUnhandled(w, "POST", err)
				return 0, false
			}
		}
		reportIDs = append(reportIDs, reportID)
		return reportID, true
	}

	var adjacentReportID *int64
	if mode, _ := object["mode"].(string); mode != "no-adjacent" {
		id, ok := createReport(marker+" previous adjacent", 7, 1, []variantInput{
			{audience: "personal", finalStatus: "current", finalContent: stringPtr("# " + marker + " previous adjacent personal final"), accepted: true},
			{audience: "leadership", finalStatus: "current", finalContent: stringPtr("# " + marker + " previous adjacent leadership final"), accepted: true},
		})
		if !ok {
			return
		}
		adjacentReportID = &id
	}

	sameAudienceReportID, ok := createReport(marker+" personal history", 21, 15, []variantInput{
		{audience: "personal", finalStatus: "current", finalContent: stringPtr("# " + marker + " searchable personal final"), accepted: true},
		{audience: "leadership", finalStatus: "none", finalContent: nil, accepted: false},
	})
	if !ok {
		return
	}

	crossAudienceReportID, ok := createReport(marker+" leadership only", 14, 8, []variantInput{
		{audience: "leadership", finalStatus: "current", finalContent: stringPtr("# " + marker + " leadership secret"), accepted: true},
		{audience: "personal", finalStatus: "none", finalContent: nil, accepted: false},
	})
	if !ok {
		return
	}

	longReportID, ok := createReport(marker+" long content", 63, 57, []variantInput{
		{audience: "personal", finalStatus: "current", finalContent: stringPtr("# " + marker + " long content\n\n" + strings.Repeat("x", 41_000)), accepted: true},
	})
	if !ok {
		return
	}

	currentLegacyReportID, ok := createReport(marker+" legacy current excluded", 49, 43, []variantInput{
		{audience: "personal", finalStatus: "current", finalContent: stringPtr("# " + marker + " legacy current secret"), accepted: false},
	})
	if !ok {
		return
	}

	staleReportID, ok := createReport(marker+" stale excluded", 28, 22, []variantInput{
		{audience: "personal", finalStatus: "stale", finalContent: stringPtr("# " + marker + " personal stale secret"), accepted: true},
		{audience: "leadership", finalStatus: "stale", finalContent: stringPtr("# " + marker + " leadership stale secret"), accepted: true},
	})
	if !ok {
		return
	}

	// legacy 报告直接插 reports 行（没有 variants），读取路径回落 reports.content。
	legacyReportID, err := insertReport(ctx, q, db.InsertReportParams{
		Title:     marker + " legacy readable",
		Content:   "# " + marker + " legacy readable content\n\n" + marker + " legacy grep target",
		WeekStart: formatLocalDay(subDays(targetStart, 56)),
		WeekEnd:   formatLocalDay(subDays(targetStart, 50)),
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeUnhandled(w, "POST", err)
		return
	}
	reportIDs = append(reportIDs, legacyReportID)

	noneReportID, ok := createReport(marker+" none excluded", 35, 29, []variantInput{
		{audience: "personal", finalStatus: "none", finalContent: nil, accepted: false},
		{audience: "leadership", finalStatus: "none", finalContent: nil, accepted: false},
	})
	if !ok {
		return
	}

	unacceptedReportID, ok := createReport(marker+" unaccepted excluded", 42, 36, []variantInput{
		{audience: "personal", finalStatus: "none", finalContent: stringPtr("# " + marker + " personal unaccepted preview secret"), accepted: false},
		{audience: "leadership", finalStatus: "none", finalContent: stringPtr("# " + marker + " leadership unaccepted preview secret"), accepted: false},
	})
	if !ok {
		return
	}

	respond.JSON(w, http.StatusCreated, reportQueryBody{
		ReportIDs:             reportIDs,
		AdjacentReportID:      adjacentReportID,
		SameAudienceReportID:  sameAudienceReportID,
		CrossAudienceReportID: crossAudienceReportID,
		LongReportID:          longReportID,
		CurrentLegacyReportID: currentLegacyReportID,
		StaleReportID:         staleReportID,
		LegacyReportID:        legacyReportID,
		NoneReportID:          noneReportID,
		UnacceptedReportID:    unacceptedReportID,
	})
}

// insertReport 用 common.sql 的 InsertReport 写一条 reports 行并返回 id。
// ai_style_override 保持 NULL：fixtures 不写该列。
func insertReport(ctx context.Context, q *db.Queries, params db.InsertReportParams) (int64, error) {
	report, err := q.InsertReport(ctx, params)
	if err != nil {
		return 0, err
	}
	return report.ID, nil
}

// positiveIntegerList 复刻 `Array.isArray(x) ? x.filter(v => Number.isInteger(v) && v > 0) : []`。
//
// 返回两层值：queryIDs 是能绑进 SQL 的 int64（超出 int64 的 JS 整数不可能是任何
// 行的 id，SQLite 按 REAL 比较也删不到东西），count 是过滤后的 JS 数组长度——
// route.ts 的 `deleted` 计数用后者，包含超出范围但仍是正整数的值。
func positiveIntegerList(value any) (queryIDs []int64, count int) {
	items, ok := value.([]any)
	if !ok {
		return nil, 0
	}
	for _, item := range items {
		number, ok := item.(float64)
		if !ok {
			continue
		}
		if !isIntegerNumber(number) || number <= 0 {
			continue
		}
		count++
		// 2^63 本身已超出 int64（float64 精确表示），绑定会溢出，跳过即可。
		if number < math.MaxInt64 {
			queryIDs = append(queryIDs, int64(number))
		}
	}
	return queryIDs, count
}

// isIntegerNumber 复刻 `Number.isInteger(value)`：有限且无小数部分即为真
// （1e20 也是整数，范围语义由各调用方决定）。
func isIntegerNumber(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return false
	}
	return math.Trunc(value) == value
}

// parseISODate 复刻 date-fns 的 parseISO 在 fixture 语料里的可观测形态：纯日期
// （YYYY-MM-DD）按本地午夜解释，其余形态按 Date Time String Format 解释后落到本地
// 时区。reports.week_start 由 reports 路由按 DATE_REGEX 校验，正常只出现前者。
func parseISODate(value string) (time.Time, bool) {
	candidate := value
	if len(value) == 10 && value[4] == '-' && value[7] == '-' {
		// date-fns 的 parseISO 对纯日期返回本地午夜，等价于 `new Date(value + 'T00:00:00')`。
		candidate = value + "T00:00:00"
	}
	parsed := jsdate.ParseString(candidate)
	if !parsed.Valid {
		return time.Time{}, false
	}
	return time.UnixMilli(parsed.Millis).In(time.Local), true
}

// subDays 复刻 date-fns 的 subDays：`setDate(getDate() - n)` 保持本地时间点不变，
// 等价于本地日历日平移。
func subDays(t time.Time, days int) time.Time { return t.AddDate(0, 0, -days) }

// formatLocalDay 复刻 date-fns `format(date, 'yyyy-MM-dd')`：本地日历日。
func formatLocalDay(t time.Time) string { return t.In(time.Local).Format("2006-01-02") }

func stringPtr(value string) *string { return &value }
