package reports

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/officialtemplates"
	"github.com/dev-zapi/weekly-reporter/internal/template"
)

// 本文件移植 src/lib/reports/service.ts。所有时间列在库里都是 Unix 秒
// （drizzle 的 integer mode:'timestamp'），读出的 Date 只在响应序列化时使用。

// TemplateSelection 是 getTemplateSelection 的结果。
type TemplateSelection struct {
	// ID 是请求里用的模板标识：官方模板直接是 `official-*`，用户模板是 `user-<id>`。
	ID      string
	Name    string
	Content string
	AiStyle string
}

// GetTemplateSelection 复刻 getTemplateSelection(templateId)：
//   - `official-` 前缀只在官方种子里查；
//   - `user-` 前缀把剩余部分按 JS 的 parseInt 解析后查 templates 表；
//   - 其它前缀（含空串）一律 nil。
func GetTemplateSelection(ctx context.Context, queries *db.Queries, templateID string) (*TemplateSelection, error) {
	if len(templateID) >= len("official-") && templateID[:len("official-")] == "official-" {
		tpl, ok := officialtemplates.ByID(templateID)
		if !ok {
			return nil, nil
		}
		return &TemplateSelection{ID: tpl.ID, Name: tpl.Name, Content: tpl.Content, AiStyle: tpl.AiStyle}, nil
	}

	if len(templateID) < len("user-") || templateID[:len("user-")] != "user-" {
		return nil, nil
	}
	numericID, ok := parseUserTemplateID(templateID[len("user-"):])
	if !ok {
		return nil, nil
	}

	row, err := queries.GetTemplateForTemplateRoutes(ctx, numericID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// `row.aiStyle ?? 'formal'`：列是 NOT NULL，空串不是 nullish，保持原值。
	return &TemplateSelection{ID: templateID, Name: row.Name, Content: row.Content, AiStyle: row.AiStyle}, nil
}

// WeekBounds 是 parseWeekBoundary 的产物：请求偏移所代表日历日的当天首毫秒 /
// 末毫秒（Unix 秒）。
//
// 迁移前 date-fns 的 parseISO 对纯日期按**进程本地时间**解释，startOfDay /
// endOfDay 也作用在本地日历日上——那正是「服务器时区决定用户日历」的问题。
// 现在周界由请求自带的偏移（time.FixedZone）决定：同一个请求在任何服务器时区
// 上都框定同一批事件。
type WeekBounds struct {
	// Valid=false 对应 TS 里 parseISO 得到的 Invalid Date：BETWEEN 变成恒假，
	// 查询照常执行并返回空集。
	Valid bool
	Start int64
	End   int64
}

// ParseWeekBounds 复刻 parseWeekBoundary(weekStart, false) / (weekEnd, true)，
// 日界落在请求偏移上。startLocation / endLocation 来自两个入参各自的偏移；
// 缺失偏移的调用方（regenerate-source 只有存储的 date-only 周期键）传 nil，
// 退回进程本地时区以保持迁移前的行为。
func ParseWeekBounds(weekStart, weekEnd string, startLocation, endLocation *time.Location) (start, end WeekBounds) {
	start = dayBoundary(weekStart, false, startLocation)
	end = dayBoundary(weekEnd, true, endLocation)
	return start, end
}

// dayBoundary 把 `YYYY-MM-DD` 折成 location 当天首/末毫秒。
//
// 输入形状由冻结契约保证：validation.go 的 parseWeekInstant 只会产出 date-only
// 周期键。日历合法性由 ParseISODate 负责（`2026-02-30` → Invalid Date）。
func dayBoundary(value string, endOfDay bool, location *time.Location) WeekBounds {
	year, month, day, ok := ParseISODate(value)
	if !ok {
		return WeekBounds{}
	}
	if location == nil {
		location = time.Local
	}
	if !endOfDay {
		instant := dateInstantIn(year, month, day, 0, 0, 0, location)
		return WeekBounds{Valid: true, Start: instant.Unix()}
	}
	instant := dateInstantIn(year, month, day, 23, 59, 59, location)
	return WeekBounds{Valid: true, End: instant.Unix()}
}

// ParseISODate 解析严格的 `YYYY-MM-DD` 并做日历范围校验。
func ParseISODate(value string) (year, month, day int, ok bool) {
	if len(value) != len("2006-01-02") || value[4] != '-' || value[7] != '-' {
		return 0, 0, 0, false
	}
	for _, index := range []int{0, 1, 2, 3, 5, 6, 8, 9} {
		if value[index] < '0' || value[index] > '9' {
			return 0, 0, 0, false
		}
	}
	year, _ = strconv.Atoi(value[0:4])
	month, _ = strconv.Atoi(value[5:7])
	day, _ = strconv.Atoi(value[8:10])
	if month < 1 || month > 12 || day < 1 || day > DaysInMonth(year, month) {
		return 0, 0, 0, false
	}
	return year, month, day, true
}

// daysInMonth 按公历（含闰年规则）返回当月天数。
func DaysInMonth(year, month int) int {
	switch month {
	case 4, 6, 9, 11:
		return 30
	case 2:
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	}
	return 31
}

// SourceScopes 复刻 getSourceScopes()：采集源 id → 项目范围映射。
func SourceScopes(ctx context.Context, queries *db.Queries) (map[int64]template.ProjectScope, error) {
	rows, err := queries.ListCollectSourceScopesForReportRoutes(ctx)
	if err != nil {
		return nil, err
	}
	scopes := make(map[int64]template.ProjectScope, len(rows))
	for _, row := range rows {
		scopes[row.ID] = template.ProjectScope(row.ProjectScope)
	}
	return scopes, nil
}

// findEventsForWeek 复刻 findEventsForWeek：BETWEEN 请求偏移上的两天边界。
//
// 任一边界无效时 drizzle 仍然发出 `event_time BETWEEN ? AND ?`，只是绑定了
// NaN/null，条件恒假——这里用一个不可能成立的区间表达同一结果（返回空集）。
func findEventsForWeek(ctx context.Context, queries *db.Queries, weekStart, weekEnd string, startLocation, endLocation *time.Location) ([]db.ListRawEventsBetweenForReportRoutesRow, error) {
	start, end := ParseWeekBounds(weekStart, weekEnd, startLocation, endLocation)
	if !start.Valid || !end.Valid {
		return nil, nil
	}
	return queries.ListRawEventsBetweenForReportRoutes(ctx, db.ListRawEventsBetweenForReportRoutesParams{
		FromEventTime: start.Start,
		ToEventTime:   end.End,
	})
}

// draftEventsFromRows 把 raw_events 行折成原稿输入。
//
// metadata 是 drizzle 的 json mode 列：TS 查询时对每行 JSON.parse，非法 JSON
// 会让整个 findEventsForWeek 抛错（route.ts 的 catch → 500）。这里同样把解析
// 失败作为错误返回，避免损坏数据被静默当成「无来源的手动事件」。
func draftEventsFromRows(rows []db.ListRawEventsBetweenForReportRoutesRow) ([]DraftEvent, error) {
	events := make([]DraftEvent, 0, len(rows))
	for _, row := range rows {
		id := row.ID
		sourceID, sourceIDPresent, repo, err := eventMetadataFacts(row.Metadata)
		if err != nil {
			return nil, fmt.Errorf("raw_events id=%d metadata: %w", row.ID, err)
		}
		events = append(events, DraftEvent{
			ID:              &id,
			EventTime:       row.EventTime,
			Source:          row.Source,
			Content:         row.Content,
			SourceID:        sourceID,
			SourceIDPresent: sourceIDPresent,
			Repo:            repo,
		})
	}
	return events, nil
}

// VariantDrafts 是 variantSourceDrafts 的结果：两个受众的原稿。
type VariantDrafts struct {
	Leadership string
	Personal   string
}

// VariantSourceDrafts 复刻 variantSourceDrafts。
func VariantSourceDrafts(events []DraftEvent, sourceScopes map[int64]template.ProjectScope) VariantDrafts {
	return VariantDrafts{
		Leadership: BuildSourceDraft(events, "leadership", sourceScopes),
		Personal:   BuildSourceDraft(events, "personal", sourceScopes),
	}
}

// PreviewVariant 是 previewReportSourceDrafts 的元素（顺序 = AUDIENCE_VARIANTS）。
type PreviewVariant struct {
	Variant     string `json:"variant"`
	SourceDraft string `json:"sourceDraft"`
}

// PreviewReportSourceDrafts 复刻 previewReportSourceDrafts。
func PreviewReportSourceDrafts(ctx context.Context, queries *db.Queries, weekStart, weekEnd string, startLocation, endLocation *time.Location) ([]PreviewVariant, error) {
	events, scopes, err := collectSourceDraftInputs(ctx, queries, weekStart, weekEnd, startLocation, endLocation)
	if err != nil {
		return nil, err
	}
	draftEvents, err := draftEventsFromRows(events)
	if err != nil {
		return nil, err
	}
	drafts := VariantSourceDrafts(draftEvents, scopes)
	return []PreviewVariant{
		{Variant: "leadership", SourceDraft: drafts.Leadership},
		{Variant: "personal", SourceDraft: drafts.Personal},
	}, nil
}

func collectSourceDraftInputs(ctx context.Context, queries *db.Queries, weekStart, weekEnd string, startLocation, endLocation *time.Location) ([]db.ListRawEventsBetweenForReportRoutesRow, map[int64]template.ProjectScope, error) {
	events, err := findEventsForWeek(ctx, queries, weekStart, weekEnd, startLocation, endLocation)
	if err != nil {
		return nil, nil, err
	}
	scopes, err := SourceScopes(ctx, queries)
	if err != nil {
		return nil, nil, err
	}
	return events, scopes, nil
}

// CreatedReport 是 createReportWithSourceDrafts 的返回值：报告行、两个变体行与
// 第 1 版快照（都按 drizzle 的属性名序列化成 camelCase）。
type CreatedReport struct {
	Report    ReportJSON
	Variants  []VariantJSON
	Snapshots []SnapshotJSON
}

// CreateReportInput 是创建报告的输入：周期键是 date-only，Location 是请求偏移
// （创建时用于框定事件窗口；落库的仍只有周期键）。
type CreateReportInput struct {
	Title         string
	WeekStart     string
	WeekEnd       string
	StartLocation *time.Location
	EndLocation   *time.Location
}

// CreateReportWithSourceDrafts 复刻 createReportWithSourceDrafts：一个事务里写
// report + 快照 + 两个变体，返回时再按 (reportId, sourceRevision=1) 读回快照。
//
// now 由调用方给出，便于测试固定时间戳。
func CreateReportWithSourceDrafts(ctx context.Context, queries *db.Queries, input CreateReportInput, now int64) (CreatedReport, error) {
	events, scopes, err := collectSourceDraftInputs(ctx, queries, input.WeekStart, input.WeekEnd, input.StartLocation, input.EndLocation)
	if err != nil {
		return CreatedReport{}, err
	}
	draftEvents, err := draftEventsFromRows(events)
	if err != nil {
		return CreatedReport{}, err
	}
	drafts := VariantSourceDrafts(draftEvents, scopes)

	created := CreatedReport{}
	err = queries.InTx(ctx, func(tx *db.Queries) error {
		report, err := tx.InsertReport(ctx, db.InsertReportParams{
			Title:           input.Title,
			Content:         drafts.Personal, // 旧版列表/搜索客户端仍读这一列
			WeekStart:       input.WeekStart,
			WeekEnd:         input.WeekEnd,
			AiStyleOverride: nil,
			CreatedAt:       now,
			UpdatedAt:       now,
		})
		if err != nil {
			return err
		}

		for _, event := range events {
			facts, err := metadataSourceFacts(event.Metadata)
			if err != nil {
				return err
			}
			classification := ClassifyEventForVariants(facts, scopes)
			if err := tx.InsertReportSnapshotForReportRoutes(ctx, db.InsertReportSnapshotForReportRoutesParams{
				ReportID:           report.ID,
				RawEventID:         &event.ID,
				EventTime:          event.EventTime,
				Source:             event.Source,
				Content:            event.Content,
				Metadata:           metadataPointer(event.Metadata),
				ProjectScope:       scopeString(classification.ProjectScope),
				LeadershipIncluded: boolToInt(classification.LeadershipIncluded),
				PersonalIncluded:   boolToInt(classification.PersonalIncluded),
				SourceRevision:     1,
				CreatedAt:          now,
			}); err != nil {
				return err
			}
		}

		variants := make([]int64, 0, len(AudienceVariants))
		for _, variant := range AudienceVariants {
			id, err := tx.InsertReportVariantForReportRoutes(ctx, db.InsertReportVariantForReportRoutesParams{
				ReportID:       report.ID,
				Variant:        variant,
				SourceDraft:    draftFor(drafts, variant),
				FinalStatus:    "none",
				SourceRevision: 1,
				CreatedAt:      now,
				UpdatedAt:      now,
			})
			if err != nil {
				return err
			}
			variants = append(variants, id)
		}

		created.Report = ReportToJSON(report)
		variantRows, err := tx.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
			IDFilter:     int64(0),
			ReportFilter: int64(1),
			ReportID:     report.ID,
		})
		if err != nil {
			return err
		}
		created.Variants = VariantsToJSON(variantRows)
		return nil
	})
	if err != nil {
		return CreatedReport{}, err
	}

	snapshots, err := queries.ListReportSnapshotsForReportRoutes(ctx, db.ListReportSnapshotsForReportRoutesParams{
		ReportID:       created.Report.ID,
		SourceRevision: 1,
	})
	if err != nil {
		return CreatedReport{}, err
	}
	created.Snapshots = SnapshotsToJSON(snapshots)
	return created, nil
}

// ReportBundle 是 getReportBundle 的结果：报告行 + 全部变体 + 当前版本快照。
type ReportBundle struct {
	Report    ReportJSON
	Variants  []VariantJSON
	Snapshots []SnapshotJSON
}

// GetReportBundle 复刻 getReportBundle：currentRevision = max(0, ...变体的
// sourceRevision)，快照只取该版本。
func GetReportBundle(ctx context.Context, queries *db.Queries, reportID int64) (*ReportBundle, error) {
	report, err := queries.GetReportForReportRoutes(ctx, reportID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	variantRows, err := queries.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
		IDFilter:     int64(0),
		ReportFilter: int64(1),
		ReportID:     reportID,
	})
	if err != nil {
		return nil, err
	}
	currentRevision := int64(0)
	for _, variant := range variantRows {
		if variant.SourceRevision > currentRevision {
			currentRevision = variant.SourceRevision
		}
	}

	snapshots, err := queries.ListReportSnapshotsForReportRoutes(ctx, db.ListReportSnapshotsForReportRoutesParams{
		ReportID:       reportID,
		SourceRevision: currentRevision,
	})
	if err != nil {
		return nil, err
	}
	return &ReportBundle{
		Report:    ReportToJSON(report),
		Variants:  VariantsToJSON(variantRows),
		Snapshots: SnapshotsToJSON(snapshots),
	}, nil
}

// RegenerateSourceDrafts 复刻 regenerateSourceDrafts：重算两个受众的原稿，
// 版本号 +1、旧终版标 stale，并把个人版原稿写回 reports.content。
func RegenerateSourceDrafts(ctx context.Context, queries *db.Queries, reportID int64, now int64) (*ReportBundle, error) {
	report, err := queries.GetReportForReportRoutes(ctx, reportID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// 存储里只有 date-only 周期键，regenerate 请求没有可用的客户端偏移；沿用
	// 迁移前的进程本地日界，保持既有报告的重算结果不变。
	events, scopes, err := collectSourceDraftInputs(ctx, queries, report.WeekStart, report.WeekEnd, time.Local, time.Local)
	if err != nil {
		return nil, err
	}
	draftEvents, err := draftEventsFromRows(events)
	if err != nil {
		return nil, err
	}
	drafts := VariantSourceDrafts(draftEvents, scopes)

	err = queries.InTx(ctx, func(tx *db.Queries) error {
		current, err := tx.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
			IDFilter:     int64(0),
			ReportFilter: int64(1),
			ReportID:     reportID,
		})
		if err != nil {
			return err
		}
		nextRevision := int64(0)
		for _, variant := range current {
			if variant.SourceRevision > nextRevision {
				nextRevision = variant.SourceRevision
			}
		}
		nextRevision++

		for _, event := range events {
			facts, err := metadataSourceFacts(event.Metadata)
			if err != nil {
				return err
			}
			classification := ClassifyEventForVariants(facts, scopes)
			if err := tx.InsertReportSnapshotForReportRoutes(ctx, db.InsertReportSnapshotForReportRoutesParams{
				ReportID:           reportID,
				RawEventID:         &event.ID,
				EventTime:          event.EventTime,
				Source:             event.Source,
				Content:            event.Content,
				Metadata:           metadataPointer(event.Metadata),
				ProjectScope:       scopeString(classification.ProjectScope),
				LeadershipIncluded: boolToInt(classification.LeadershipIncluded),
				PersonalIncluded:   boolToInt(classification.PersonalIncluded),
				SourceRevision:     nextRevision,
				CreatedAt:          now,
			}); err != nil {
				return err
			}
		}

		for _, variant := range AudienceVariants {
			existing := findVariantRow(current, variant)
			if existing != nil {
				finalStatus := "none"
				// `existing.finalContent ? 'stale' : 'none'`：空串也是假值。
				if existing.FinalContent != nil && *existing.FinalContent != "" {
					finalStatus = "stale"
				}
				if err := tx.UpdateReportVariantSourceForReportRoutes(ctx, db.UpdateReportVariantSourceForReportRoutesParams{
					SourceDraft:    draftFor(drafts, variant),
					SourceRevision: nextRevision,
					FinalStatus:    finalStatus,
					UpdatedAt:      now,
					ID:             existing.ID,
				}); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.InsertReportVariantForReportRoutes(ctx, db.InsertReportVariantForReportRoutesParams{
				ReportID:       reportID,
				Variant:        variant,
				SourceDraft:    draftFor(drafts, variant),
				FinalStatus:    "none",
				SourceRevision: nextRevision,
				CreatedAt:      now,
				UpdatedAt:      now,
			}); err != nil {
				return err
			}
		}

		_, err = tx.UpdateReportContentForReportRoutes(ctx, db.UpdateReportContentForReportRoutesParams{
			Content:   drafts.Personal,
			UpdatedAt: now,
			ID:        reportID,
		})
		return err
	})
	if err != nil {
		return nil, err
	}

	return GetReportBundle(ctx, queries, reportID)
}

// GetReportVariant 复刻 getReportVariant：按 (reportId, variant) 取一行。
func GetReportVariant(ctx context.Context, queries *db.Queries, reportID int64, variant string) (*VariantJSON, error) {
	rows, err := queries.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
		IDFilter:     int64(0),
		ReportFilter: int64(1),
		ReportID:     reportID,
	})
	if err != nil {
		return nil, err
	}
	for _, row := range VariantsToJSON(rows) {
		if row.Variant == variant {
			return &row, nil
		}
	}
	return nil, nil
}

func findVariantRow(rows []db.ListReportVariantsForReportRoutesRow, variant string) *db.ListReportVariantsForReportRoutesRow {
	for i := range rows {
		if rows[i].Variant == variant {
			return &rows[i]
		}
	}
	return nil
}

func draftFor(drafts VariantDrafts, variant string) string {
	if variant == "leadership" {
		return drafts.Leadership
	}
	return drafts.Personal
}

func scopeString(scope *template.ProjectScope) *string {
	if scope == nil {
		return nil
	}
	value := string(*scope)
	return &value
}

func boolToInt(value bool) int64 {
	if value {
		return 1
	}
	return 0
}
