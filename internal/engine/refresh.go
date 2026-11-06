package engine

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/engine/tools"
	"github.com/dev-zapi/weekly-reporter/internal/generation"
)

// 本文件实现 refreshHistoricalQuery（src/lib/generation/service.ts）：重跑一个
// 已落库的历史查询快照，写一条 trigger='user' 的新快照、链到旧快照，并追加
// 一条 refreshed tool-result part。返回的查询快照就是 refresh 路由的响应体。

// RefreshHistoricalQuery 复刻 refreshHistoricalQuery。
func (e *Engine) RefreshHistoricalQuery(ctx context.Context, reportID, sessionID, snapshotID int64) (*generation.QuerySnapshotJSON, error) {
	dbCtx := context.WithoutCancel(ctx)

	_, err := e.Queries.GetGenerationSessionForReportRoutes(dbCtx, db.GetGenerationSessionForReportRoutesParams{
		ID:       sessionID,
		ReportID: reportID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serviceError("Generation session not found", "SESSION_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}

	previous, err := e.Queries.GetGenerationQuerySnapshotByIDForGenerationEngine(dbCtx, db.GetGenerationQuerySnapshotByIDForGenerationEngineParams{
		ID:        snapshotID,
		SessionID: sessionID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serviceError("Query snapshot not found", "SNAPSHOT_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}
	if previous.ToolName != reportListToolName && previous.ToolName != reportContentToolName {
		return nil, serviceError("Unsupported historical query tool", "SNAPSHOT_INVALID", http.StatusBadRequest)
	}

	started := e.now()
	var result any
	switch previous.ToolName {
	case reportListToolName:
		input, parseErr := tools.ParseReportListInput(previous.Parameters)
		if parseErr != nil {
			// 快照参数在写入前已经过同一套 strictObject 校验；这里只防御历史
			// 脏数据，按默认入参重跑（与 TS 直接使用参数对象的容错一致）。
			input = tools.ReportListInput{}
		}
		result = tools.QueryReportListForSession(dbCtx, e.Queries, sessionID, input)
	case reportContentToolName:
		input, parseErr := tools.ParseReportContentInput(previous.Parameters)
		if parseErr != nil {
			input = tools.ReportContentInput{}
		}
		result = tools.QueryReportContentForSession(dbCtx, e.Queries, sessionID, input)
	}
	resultMap := resultToMap(result)
	parameters := decodedParameters(previous.Parameters)

	snapshotIDPtr := e.persistQuerySnapshot(dbCtx, sessionID, previous.ToolName, parameters, resultMap, time.Since(started).Milliseconds(), "user", &previous.ID)
	if snapshotIDPtr == nil {
		return nil, nil
	}

	content := "历史查询已刷新：" + previous.ToolName + "。历史参考·不可信。"
	if _, err := e.appendPart(dbCtx, sessionID, nil, "tool", "tool-result", &content, map[string]any{
		"toolName":   previous.ToolName,
		"output":     resultMap,
		"snapshotId": *snapshotIDPtr,
		"refreshed":  true,
	}); err != nil {
		return nil, err
	}

	row, err := e.Queries.GetGenerationQuerySnapshotByIDForGenerationEngine(dbCtx, db.GetGenerationQuerySnapshotByIDForGenerationEngineParams{
		ID:        *snapshotIDPtr,
		SessionID: sessionID,
	})
	if err != nil {
		return nil, err
	}
	var sourceUpdatedAt *string
	if row.SourceUpdatedAt != nil {
		value := jsdate.ISOStringFromUnix(*row.SourceUpdatedAt)
		sourceUpdatedAt = &value
	}
	return &generation.QuerySnapshotJSON{
		ID:                 row.ID,
		SessionID:          row.SessionID,
		ToolName:           row.ToolName,
		Parameters:         json.RawMessage(row.Parameters),
		CalledAt:           jsdate.ISOStringFromUnix(row.CalledAt),
		SourceReportID:     row.SourceReportID,
		SourceAudience:     row.SourceAudience,
		SourceUpdatedAt:    sourceUpdatedAt,
		SourceWeekStart:    row.SourceWeekStart,
		SourceWeekEnd:      row.SourceWeekEnd,
		SourceFinalStatus:  row.SourceFinalStatus,
		Result:             json.RawMessage(row.Result),
		ResultCount:        row.ResultCount,
		Truncated:          row.Truncated == 1,
		DurationMs:         row.DurationMs,
		ErrorCode:          row.ErrorCode,
		Trigger:            row.Trigger,
		PreviousSnapshotID: row.PreviousSnapshotID,
		CreatedAt:          jsdate.ISOStringFromUnix(row.CreatedAt),
	}, nil
}

// resultToMap 把类型化工具结果转成落库/回放共用的 JSON 对象。
func resultToMap(value any) map[string]any {
	text, ok := marshalJSONText(value)
	if !ok {
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal([]byte(text), &out) != nil {
		return map[string]any{}
	}
	return out
}

// decodedParameters 把库里的 parameters JSON 还原成落库用的对象形态。
func decodedParameters(raw []byte) any {
	var value any
	if len(raw) > 0 && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return map[string]any{}
}
