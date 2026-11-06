package reports

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件是 reports / report_variants / report_event_snapshots 三张表的响应形状
// （键名与 drizzle 的属性名一致，时间列是 Date 经 JSON.stringify 得到的 ISO 串）
// 与 JSON 文本列的读写换算。

// ReportJSON 是 reports 行的响应形状。
type ReportJSON struct {
	ID              int64   `json:"id"`
	Title           string  `json:"title"`
	Content         string  `json:"content"`
	WeekStart       string  `json:"weekStart"`
	WeekEnd         string  `json:"weekEnd"`
	AiStyleOverride *string `json:"aiStyleOverride"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

func ReportToJSON(row db.Report) ReportJSON {
	return ReportJSON{
		ID:              row.ID,
		Title:           row.Title,
		Content:         row.Content,
		WeekStart:       row.WeekStart,
		WeekEnd:         row.WeekEnd,
		AiStyleOverride: row.AiStyleOverride,
		CreatedAt:       jsdate.ISOStringFromUnix(row.CreatedAt),
		UpdatedAt:       jsdate.ISOStringFromUnix(row.UpdatedAt),
	}
}

// VariantJSON 是 report_variants 行的响应形状。
//
// StructureCompletenessRule 是历史列（ADR-0021 已停止写入）：保留了旧值的行
// 仍要原样回给客户端，所以这里透传 JSON。
type VariantJSON struct {
	ID                        int64           `json:"id"`
	ReportID                  int64           `json:"reportId"`
	Variant                   string          `json:"variant"`
	SourceDraft               string          `json:"sourceDraft"`
	FinalContent              *string         `json:"finalContent"`
	FinalStatus               string          `json:"finalStatus"`
	TemplateID                *string         `json:"templateId"`
	TemplateName              *string         `json:"templateName"`
	TemplateContent           *string         `json:"templateContent"`
	StructureCompletenessRule json.RawMessage `json:"structureCompletenessRule"`
	AiStyle                   *string         `json:"aiStyle"`
	AcceptedProposalID        *int64          `json:"acceptedProposalId"`
	SourceRevision            int64           `json:"sourceRevision"`
	CreatedAt                 string          `json:"createdAt"`
	UpdatedAt                 string          `json:"updatedAt"`
}

func VariantsToJSON(rows []db.ListReportVariantsForReportRoutesRow) []VariantJSON {
	variants := make([]VariantJSON, 0, len(rows))
	for _, row := range rows {
		variants = append(variants, VariantJSON{
			ID:                        row.ID,
			ReportID:                  row.ReportID,
			Variant:                   row.Variant,
			SourceDraft:               row.SourceDraft,
			FinalContent:              row.FinalContent,
			FinalStatus:               row.FinalStatus,
			TemplateID:                row.TemplateID,
			TemplateName:              row.TemplateName,
			TemplateContent:           row.TemplateContent,
			StructureCompletenessRule: jsonColumn(row.StructureCompletenessRule),
			AiStyle:                   row.AiStyle,
			AcceptedProposalID:        row.AcceptedProposalID,
			SourceRevision:            row.SourceRevision,
			CreatedAt:                 jsdate.ISOStringFromUnix(row.CreatedAt),
			UpdatedAt:                 jsdate.ISOStringFromUnix(row.UpdatedAt),
		})
	}
	return variants
}

// SnapshotJSON 是 report_event_snapshots 行的响应形状。
type SnapshotJSON struct {
	ID                 int64           `json:"id"`
	ReportID           int64           `json:"reportId"`
	RawEventID         *int64          `json:"rawEventId"`
	EventTime          string          `json:"eventTime"`
	Source             string          `json:"source"`
	Content            string          `json:"content"`
	Metadata           json.RawMessage `json:"metadata"`
	ProjectScope       *string         `json:"projectScope"`
	LeadershipIncluded bool            `json:"leadershipIncluded"`
	PersonalIncluded   bool            `json:"personalIncluded"`
	SourceRevision     int64           `json:"sourceRevision"`
	CreatedAt          string          `json:"createdAt"`
}

func SnapshotsToJSON(rows []db.ListReportSnapshotsForReportRoutesRow) []SnapshotJSON {
	snapshots := make([]SnapshotJSON, 0, len(rows))
	for _, row := range rows {
		snapshots = append(snapshots, SnapshotJSON{
			ID:                 row.ID,
			ReportID:           row.ReportID,
			RawEventID:         row.RawEventID,
			EventTime:          jsdate.ISOStringFromUnix(row.EventTime),
			Source:             row.Source,
			Content:            row.Content,
			Metadata:           jsonColumn(row.Metadata),
			ProjectScope:       row.ProjectScope,
			LeadershipIncluded: row.LeadershipIncluded == 1,
			PersonalIncluded:   row.PersonalIncluded == 1,
			SourceRevision:     row.SourceRevision,
			CreatedAt:          jsdate.ISOStringFromUnix(row.CreatedAt),
		})
	}
	return snapshots
}

// ISOStringFromUnix 是 jsdate.ISOStringFromUnix 的别名，避免路由包重复引包。
func ISOStringFromUnix(seconds int64) string { return jsdate.ISOStringFromUnix(seconds) }

// JSONColumn 把 BLOB 扫描出的 JSON 文本还原成响应里的值（NULL → null）。
func JSONColumn(raw []byte) json.RawMessage { return jsonColumn(raw) }

// nullJSON 是响应里 JSON 列为空时的字面量。
var nullJSON = json.RawMessage("null")

// jsonColumn 把库里读出的 JSON 列还原成 JS 侧的值。
//
// drizzle 的 json mode 是 JSON.parse + JSON.stringify：NULL → null；合法 JSON 按
// stringify 的紧凑形式重写；非法 JSON 会让整条查询抛错（route.ts 的 catch → 500）。
// json.Compact 同时做校验与紧凑化，与 events 域的 metadataFromColumn 同形。
func jsonColumn(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return nullJSON
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		// 非法 JSON 在 TS 里是查询期异常，调用方会以 500 收场；这里把原文回出去，
		// 保证「不是合法 JSON」不会变成静默的 null。
		return json.RawMessage(raw)
	}
	return json.RawMessage(compact.Bytes())
}

// metadataText 把库里读出的 metadata JSON 文本写回去（snapshot 插入用）。
//
// drizzle 的 json mode 在写入时 JSON.stringify，所以原文可能是任意合法 JSON；
// 非法 JSON 在 TS 里同样是查询期异常。
func metadataText(raw []byte) string {
	value := jsonColumn(raw)
	if bytes.Equal(value, nullJSON) {
		return "null"
	}
	return string(value)
}

// metadataPointer 是插入快照时的 metadata 参数：原样写回，NULL 保持 NULL。
func metadataPointer(raw []byte) *string {
	if len(raw) == 0 {
		return nil
	}
	text := metadataText(raw)
	return &text
}

// eventMetadataFacts 从 metadata JSON 里取 sourceId 与 repo。
//
// TS 侧是 `event.metadata?.sourceId` / `event.metadata?.repo`：非对象、缺键、
// 类型不对都得到 undefined（等价 nil/空串）。数字兼容 JSON 的 float64 与
// int64 两种解码结果。非法 JSON 在 TS 里是查询期的 JSON.parse 异常（调用方以
// 500 收场），这里同样返回错误，而不是把事件静默降级成「无来源的手动事件」。
func eventMetadataFacts(raw []byte) (*int64, bool, string, error) {
	metadata, err := decodeMetadataObject(raw)
	if err != nil {
		return nil, false, "", err
	}
	if metadata == nil {
		return nil, false, "", nil
	}
	value, present := metadata["sourceId"]
	var sourceID *int64
	if present && value != nil {
		switch typed := value.(type) {
		case float64:
			if id, ok := int64FromFloat(typed); ok {
				sourceID = &id
			}
		case int64:
			id := typed
			sourceID = &id
		}
	}
	repo, _ := metadata["repo"].(string)
	return sourceID, present && value != nil, repo, nil
}

// metadataSourceFacts 只取 sourceId（classifyEventForVariants 的输入）。
func metadataSourceFacts(raw []byte) (SourceFacts, error) {
	sourceID, present, _, err := eventMetadataFacts(raw)
	if err != nil {
		return SourceFacts{}, err
	}
	return SourceFacts{ID: sourceID, Present: present}, nil
}

func decodeMetadataObject(raw []byte) (map[string]any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	object, _ := value.(map[string]any)
	return object, nil
}

func int64FromFloat(value float64) (int64, bool) {
	// 源 id 在 schema 里是 integer；REAL 值（1.5）在 drizzle 里绑进查询只是查不到，
	// 这里按「没有命中」处理，不引入额外分支。
	truncated := int64(value)
	if float64(truncated) != value {
		return 0, false
	}
	return truncated, true
}

// parseUserTemplateID 复刻 `Number.parseInt(templateId.slice('user-'.length), 10)`：
// 容忍前导空白与数字后的垃圾，解析不出数字即 NaN。
func parseUserTemplateID(value string) (int64, bool) {
	return jsparse.ParseInt10(value)
}

// localDateInstant 在服务进程的本地时区上组装一个时刻。
//
// date-fns 的 startOfDay / endOfDay 走的是运行环境的本地日历，与 Go 的 time.Local
// 同源；周报的周边界因此与时区一致（迁移前是 Next 进程的 TZ，迁移后是 wr 的 TZ）。
func localDateInstant(year, month, day int, hour, minute, second int, nanosecond int64) time.Time {
	return time.Date(year, time.Month(month), day, hour, minute, second, int(nanosecond), time.Local)
}
