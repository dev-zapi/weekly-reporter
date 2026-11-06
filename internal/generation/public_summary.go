package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/lib/generation/public-summary.ts 的 normalizePublicGenerationSummary
// 与 src/lib/generation/query-snapshots.ts 的 listQuerySnapshots。
//
// 完整版 publicSummary 的构造（buildPublicGenerationSummary）属于提案创建路径，
// 在引擎票里；报告路由只需要读面：把库里存的 JSON 校验成 PublicGenerationSummary
// 形状，不合法时返回 null（前端据此走「旧提案」分支）。

// querySnapshotJSON 是 generation_query_snapshots 行的响应形状。
type querySnapshotJSON struct {
	ID                 int64           `json:"id"`
	SessionID          int64           `json:"sessionId"`
	ToolName           string          `json:"toolName"`
	Parameters         json.RawMessage `json:"parameters"`
	CalledAt           string          `json:"calledAt"`
	SourceReportID     int64           `json:"sourceReportId"`
	SourceAudience     string          `json:"sourceAudience"`
	SourceUpdatedAt    *string         `json:"sourceUpdatedAt"`
	SourceWeekStart    *string         `json:"sourceWeekStart"`
	SourceWeekEnd      *string         `json:"sourceWeekEnd"`
	SourceFinalStatus  *string         `json:"sourceFinalStatus"`
	Result             json.RawMessage `json:"result"`
	ResultCount        int64           `json:"resultCount"`
	Truncated          bool            `json:"truncated"`
	DurationMs         int64           `json:"durationMs"`
	ErrorCode          *string         `json:"errorCode"`
	Trigger            string          `json:"trigger"`
	PreviousSnapshotID *int64          `json:"previousSnapshotId"`
	CreatedAt          string          `json:"createdAt"`
}

// QuerySnapshotJSON 是导出给报告域复用的快照形状。
type QuerySnapshotJSON = querySnapshotJSON

// ListQuerySnapshots 复刻 listQuerySnapshots：按 id 升序返回会话的全部快照。
// TS 侧用 try/catch 把错误折成空数组，这里把错误原样返回，由调用方决定降级。
func ListQuerySnapshots(ctx context.Context, queries *db.Queries, sessionID int64) ([]QuerySnapshotJSON, error) {
	rows, err := queries.ListGenerationQuerySnapshotsForReportRoutes(ctx, sessionID)
	if err != nil {
		return []QuerySnapshotJSON{}, err
	}
	snapshots := make([]QuerySnapshotJSON, 0, len(rows))
	for _, row := range rows {
		var sourceUpdatedAt *string
		if row.SourceUpdatedAt != nil {
			value := jsdate.ISOStringFromUnix(*row.SourceUpdatedAt)
			sourceUpdatedAt = &value
		}
		snapshots = append(snapshots, QuerySnapshotJSON{
			ID:                 row.ID,
			SessionID:          row.SessionID,
			ToolName:           row.ToolName,
			Parameters:         jsonColumn(row.Parameters),
			CalledAt:           jsdate.ISOStringFromUnix(row.CalledAt),
			SourceReportID:     row.SourceReportID,
			SourceAudience:     row.SourceAudience,
			SourceUpdatedAt:    sourceUpdatedAt,
			SourceWeekStart:    row.SourceWeekStart,
			SourceWeekEnd:      row.SourceWeekEnd,
			SourceFinalStatus:  row.SourceFinalStatus,
			Result:             jsonColumn(row.Result),
			ResultCount:        row.ResultCount,
			Truncated:          row.Truncated == 1,
			DurationMs:         row.DurationMs,
			ErrorCode:          row.ErrorCode,
			Trigger:            row.Trigger,
			PreviousSnapshotID: row.PreviousSnapshotID,
			CreatedAt:          jsdate.ISOStringFromUnix(row.CreatedAt),
		})
	}
	return snapshots, nil
}

// ProposalReferenceChanged 复刻 proposalReferenceChanged：
//
//	proposal.status === 'pending' && snapshots.some(s => s.trigger === 'user' && s.createdAt > proposal.createdAt)
//
// createdAt 的比较是 Date 的数值比较（库里的精度是秒）。
func ProposalReferenceChanged(status string, proposalCreatedAt string, snapshots []QuerySnapshotJSON) bool {
	if status != "pending" {
		return false
	}
	proposalMillis, proposalOK := parseISOMillis(proposalCreatedAt)
	if !proposalOK {
		return false
	}
	for _, snapshot := range snapshots {
		if snapshot.Trigger != "user" {
			continue
		}
		snapshotMillis, ok := parseISOMillis(snapshot.CreatedAt)
		if ok && snapshotMillis > proposalMillis {
			return true
		}
	}
	return false
}

// NormalizePublicGenerationSummary 复刻 normalizePublicGenerationSummary：
// 形状不对时返回 JSON null，合法时原样透传（TS 返回的是对象本身，重新序列化
// 后与库里紧凑化的文本一致）。
func NormalizePublicGenerationSummary(value json.RawMessage) json.RawMessage {
	if len(value) == 0 || bytes.Equal(value, []byte("null")) {
		return json.RawMessage("null")
	}
	var summary map[string]any
	if err := json.Unmarshal(value, &summary); err != nil {
		return json.RawMessage("null")
	}
	version, _ := summary["version"].(float64)
	if version != 1 {
		return json.RawMessage("null")
	}
	for _, field := range []string{"modelHandling", "historicalReferences", "toolStatuses", "failureStates", "truncationStates", "changeSummary"} {
		if _, ok := summary[field].([]any); !ok {
			return json.RawMessage("null")
		}
	}
	if factBoundary, ok := summary["factBoundary"].(map[string]any); !ok || factBoundary == nil {
		return json.RawMessage("null")
	}
	compact, err := json.Marshal(summary)
	if err != nil {
		return json.RawMessage("null")
	}
	return compact
}

// jsonColumn 把 BLOB 扫描出的 JSON 文本还原成紧凑 JSON；空值 → null。
func jsonColumn(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return json.RawMessage(raw)
	}
	return json.RawMessage(compact.Bytes())
}

// parseISOMillis 解析 `2006-01-02T15:04:05.000Z` 形态的 ISO 串。
func parseISOMillis(value string) (int64, bool) {
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	if err != nil {
		return 0, false
	}
	return parsed.UnixMilli(), true
}
