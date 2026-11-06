package engine

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/engine/tools"
	"github.com/dev-zapi/weekly-reporter/internal/generation"
)

// 本文件是引擎的持久化面：逐条对照 src/lib/generation/stream.ts 与 service.ts
// 的读写。所有时间列写 Unix 秒（drizzle integer mode:'timestamp' 的实测单位）。

const (
	maxHistoryQueriesPerTurn = 10
	maxContentQueriesPerTurn = 5
	maxProposalCharacters    = 200_000
)

// aiConfig 是 ai_config 单行里引擎需要的四列。
type aiConfig struct {
	Protocol string
	BaseURL  string
	APIKey   string
	Model    string
}

// sessionDetail 复刻 getGenerationSessionDetail 的引擎视图（不经过 HTTP 形状）。
type sessionDetail struct {
	Session                      db.GenerationSession
	Parts                        []db.ListGenerationMessagePartsForReportRoutesRow
	Turns                        []db.GenerationTurn
	Proposals                    []db.ListGenerationProposalsForReportRoutesRow
	CurrentVariantSourceRevision *int64
	SourceIsCurrent              bool
}

// proposalRecord 是刚创建的提案（wire 事件与 tool-result part 需要其 id 与快照）。
type proposalRecord struct {
	ID              int64
	SessionID       int64
	TurnID          int64
	Content         string
	Summary         string // JSON array text
	SourceRevision  int64
	Status          string
	PublicSummary   string // JSON object text
	BaselineContent *string
	CreatedAt       int64
}

func (e *Engine) loadDetail(ctx context.Context, reportID, sessionID int64) (*sessionDetail, error) {
	session, err := e.Queries.GetGenerationSessionForReportRoutes(ctx, db.GetGenerationSessionForReportRoutesParams{
		ID:       sessionID,
		ReportID: reportID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	parts, err := e.Queries.ListGenerationMessagePartsForReportRoutes(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	turns, err := e.Queries.ListGenerationTurnsForReportRoutes(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	proposals, err := e.Queries.ListGenerationProposalsForReportRoutes(ctx, db.ListGenerationProposalsForReportRoutesParams{
		IDFilter:      int64(0),
		SessionFilter: int64(1),
		SessionID:     sessionID,
	})
	if err != nil {
		return nil, err
	}
	variants, err := e.Queries.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
		IDFilter:     int64(1),
		ID:           session.ReportVariantID,
		ReportFilter: int64(0),
	})
	if err != nil {
		return nil, err
	}
	var revision *int64
	for _, variant := range variants {
		if variant.ID == session.ReportVariantID {
			value := variant.SourceRevision
			revision = &value
			break
		}
	}

	return &sessionDetail{
		Session:                      session,
		Parts:                        parts,
		Turns:                        turns,
		Proposals:                    proposals,
		CurrentVariantSourceRevision: revision,
		SourceIsCurrent:              revision != nil && *revision == session.SourceRevision,
	}, nil
}

func (e *Engine) loadAIConfig(ctx context.Context) (*aiConfig, error) {
	row, err := e.Queries.GetAIConfigForAI(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &aiConfig{Protocol: row.Protocol, BaseURL: row.ApiUrl, APIKey: row.ApiKey, Model: row.Model}, nil
}

// appendPart 复刻 appendGenerationPart：sequence = max+1，BEGIN IMMEDIATE 包住
// 读 max 与插入（ADR-0027；Next 运行时可能同时在写同一个库）。
func (e *Engine) appendPart(ctx context.Context, sessionID int64, turnID *int64, role, partType string, content *string, data any) (int64, error) {
	var dataText *string
	if data != nil {
		text, ok := marshalJSONText(data)
		if !ok {
			return 0, errors.New("engine: cannot marshal part data")
		}
		dataText = &text
	}
	var id int64
	err := e.Queries.InImmediateTx(ctx, func(tx *db.Queries) error {
		sequence, err := nextSequence(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		created, err := tx.InsertGenerationMessagePartForGenerationEngine(ctx, db.InsertGenerationMessagePartForGenerationEngineParams{
			SessionID: sessionID,
			TurnID:    turnID,
			Sequence:  sequence,
			Role:      role,
			PartType:  partType,
			Content:   content,
			Data:      dataText,
			CreatedAt: e.now().Unix(),
		})
		if err != nil {
			return err
		}
		id = created
		return nil
	})
	return id, err
}

func nextSequence(ctx context.Context, queries *db.Queries, sessionID int64) (int64, error) {
	latest, err := queries.GetLatestGenerationMessageSequenceForReportRoutes(ctx, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	return latest + 1, nil
}

// startGenerationTurn 复刻 startGenerationTurn 的事务：重查原稿版本、拒绝并发
// working 轮、插入轮次 + 用户 part + 状态 part、touch 会话 updated_at。
func (e *Engine) startGenerationTurn(ctx context.Context, session *db.GenerationSession, cfg aiConfig, userMessage string) (*db.GenerationTurn, error) {
	userMessage = jsstr.Trim(userMessage)
	if userMessage == "" {
		return nil, serviceError("Message is required", "EMPTY_MESSAGE", http.StatusBadRequest)
	}
	if session.Status != "active" {
		return nil, serviceError("Session is archived", "SESSION_ARCHIVED", http.StatusConflict)
	}

	var turn db.GenerationTurn
	err := e.Queries.InImmediateTx(ctx, func(tx *db.Queries) error {
		variants, err := tx.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
			IDFilter:     int64(1),
			ID:           session.ReportVariantID,
			ReportFilter: int64(0),
		})
		if err != nil {
			return err
		}
		current := false
		for _, variant := range variants {
			if variant.ID == session.ReportVariantID && variant.SourceRevision == session.SourceRevision {
				current = true
				break
			}
		}
		if !current {
			return errSourceRevisionConflict("The source draft has changed; start a new session")
		}

		if _, err := tx.GetWorkingGenerationTurnForReportRoutes(ctx, session.ID); err == nil {
			return serviceError("This session already has a turn in progress", "TURN_IN_PROGRESS", http.StatusConflict)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		now := e.now().Unix()
		created, err := tx.InsertGenerationTurnForGenerationEngine(ctx, db.InsertGenerationTurnForGenerationEngineParams{
			SessionID: session.ID,
			Protocol:  cfg.Protocol,
			Model:     cfg.Model,
			CreatedAt: now,
		})
		if err != nil {
			return err
		}
		turn = created

		sequence, err := nextSequence(ctx, tx, session.ID)
		if err != nil {
			return err
		}
		if _, err := tx.InsertGenerationMessagePartForGenerationEngine(ctx, db.InsertGenerationMessagePartForGenerationEngineParams{
			SessionID: session.ID,
			TurnID:    &created.ID,
			Sequence:  sequence,
			Role:      "user",
			PartType:  "text",
			Content:   &userMessage,
			CreatedAt: now,
		}); err != nil {
			return err
		}
		statusContent := "Working..."
		statusData := `{"status":"working"}`
		if _, err := tx.InsertGenerationMessagePartForGenerationEngine(ctx, db.InsertGenerationMessagePartForGenerationEngineParams{
			SessionID: session.ID,
			TurnID:    &created.ID,
			Sequence:  sequence + 1,
			Role:      "application",
			PartType:  "status",
			Content:   &statusContent,
			Data:      &statusData,
			CreatedAt: now,
		}); err != nil {
			return err
		}
		return tx.UpdateGenerationSessionUpdatedAtForGenerationEngine(ctx, db.UpdateGenerationSessionUpdatedAtForGenerationEngineParams{
			UpdatedAt: now,
			ID:        session.ID,
		})
	})
	if err != nil {
		return nil, err
	}
	return &turn, nil
}

// finishGenerationTurn 复刻 finishGenerationTurn：更新轮次/会话、重写状态 part，
// 失败时追加 error part。
func (e *Engine) finishGenerationTurn(ctx context.Context, turnID int64, status string, errorMessage *string) (*db.GenerationTurn, error) {
	turn, err := e.Queries.GetGenerationTurnByIDForGenerationEngine(ctx, turnID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	now := e.now().Unix()
	if _, err := e.Queries.UpdateGenerationTurnFinishForGenerationEngine(ctx, db.UpdateGenerationTurnFinishForGenerationEngineParams{
		Status:     status,
		Error:      errorMessage,
		FinishedAt: &now,
		ID:         turnID,
	}); err != nil {
		return nil, err
	}
	if err := e.Queries.UpdateGenerationSessionUpdatedAtForGenerationEngine(ctx, db.UpdateGenerationSessionUpdatedAtForGenerationEngineParams{
		UpdatedAt: now,
		ID:        turn.SessionID,
	}); err != nil {
		return nil, err
	}

	statusContent := map[string]string{
		"completed": "Completed",
		"aborted":   "Stopped",
		"failed":    "Generation failed",
	}[status]
	statusData, _ := marshalJSONText(map[string]string{"status": status})
	if err := e.Queries.UpdateGenerationStatusPartForGenerationEngine(ctx, db.UpdateGenerationStatusPartForGenerationEngineParams{
		Content: &statusContent,
		Data:    statusData,
		TurnID:  &turnID,
	}); err != nil {
		return nil, err
	}
	if errorMessage != nil {
		if _, err := e.appendPart(ctx, turn.SessionID, &turnID, "application", "error", errorMessage, nil); err != nil {
			return nil, err
		}
	}
	result, err := e.Queries.GetGenerationTurnByIDForGenerationEngine(ctx, turnID)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// createGenerationProposal 复刻 createGenerationProposal（校验、supersede、插入、
// publicSummary 构造）。调用方负责把 ServiceError 归一成 tool-error。
func (e *Engine) createGenerationProposal(
	ctx context.Context,
	session *db.GenerationSession,
	turnID int64,
	input tools.ProposeFinalReportInput,
) (*proposalRecord, error) {
	content := jsstr.Trim(input.Content)
	summary := make([]string, 0, len(input.Summary))
	for _, item := range input.Summary {
		if trimmed := jsstr.Trim(item); trimmed != "" {
			summary = append(summary, trimmed)
		}
	}
	if content == "" {
		return nil, serviceError("Proposal content is required", "EMPTY_PROPOSAL", http.StatusBadRequest)
	}
	if jsstr.UTF16Len(content) > maxProposalCharacters {
		return nil, serviceError("Proposal content is too long", "PROPOSAL_TOO_LARGE", http.StatusBadRequest)
	}

	var record *proposalRecord
	err := e.Queries.InTx(ctx, func(tx *db.Queries) error {
		stored, err := tx.GetGenerationSessionByIDForGenerationEngine(ctx, session.ID)
		if errors.Is(err, sql.ErrNoRows) {
			return errSessionNotFound()
		}
		if err != nil {
			return err
		}

		variants, err := tx.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
			IDFilter:     int64(1),
			ID:           stored.ReportVariantID,
			ReportFilter: int64(0),
		})
		if err != nil {
			return err
		}
		variantCurrent := false
		for _, variant := range variants {
			if variant.ID == stored.ReportVariantID && variant.SourceRevision == stored.SourceRevision {
				variantCurrent = true
				break
			}
		}
		if !variantCurrent {
			return errSourceRevisionConflict("The source draft changed; this proposal is based on an older version")
		}

		turn, err := tx.GetGenerationTurnByIDForGenerationEngine(ctx, turnID)
		if errors.Is(err, sql.ErrNoRows) {
			return serviceError("The current generation turn has ended", "TURN_NOT_ACTIVE", http.StatusConflict)
		}
		if err != nil {
			return err
		}
		if turn.SessionID != stored.ID || turn.Status != "working" {
			return serviceError("The current generation turn has ended", "TURN_NOT_ACTIVE", http.StatusConflict)
		}

		if _, err := tx.GetGenerationProposalByTurnForGenerationEngine(ctx, turnID); err == nil {
			return serviceError("Only one proposal may be submitted per turn", "PROPOSAL_LIMIT", http.StatusConflict)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		effective := summary
		if len(effective) > 8 {
			effective = effective[:8]
		}

		parts, err := tx.ListGenerationMessagePartsForReportRoutes(ctx, stored.ID)
		if err != nil {
			return err
		}
		listResults, contentResults := sessionToolResults(parts)

		var explicit []string
		if input.PublicSummary != nil {
			explicit = input.PublicSummary.ModelHandling
		}
		publicSummary := generation.BuildPublicGenerationSummary(explicit, summary, listResults, contentResults)
		publicSummaryText, ok := marshalJSONText(publicSummary)
		if !ok {
			return errors.New("engine: cannot marshal public summary")
		}
		summaryJSON, ok := marshalJSONText(effective)
		if !ok {
			return errors.New("engine: cannot marshal summary")
		}
		baseline := ""
		if stored.BaselineFinalContent != nil {
			baseline = *stored.BaselineFinalContent
		}

		if err := tx.SupersedePendingProposalsForGenerationEngine(ctx, stored.ID); err != nil {
			return err
		}
		now := e.now().Unix()
		id, err := tx.InsertGenerationProposalForGenerationEngine(ctx, db.InsertGenerationProposalForGenerationEngineParams{
			SessionID:       stored.ID,
			TurnID:          turnID,
			Content:         content,
			Summary:         summaryJSON,
			SourceRevision:  stored.SourceRevision,
			PublicSummary:   &publicSummaryText,
			BaselineContent: &baseline,
			CreatedAt:       now,
		})
		if err != nil {
			return err
		}
		record = &proposalRecord{
			ID:              id,
			SessionID:       stored.ID,
			TurnID:          turnID,
			Content:         content,
			Summary:         summaryJSON,
			SourceRevision:  stored.SourceRevision,
			Status:          "pending",
			PublicSummary:   publicSummaryText,
			BaselineContent: &baseline,
			CreatedAt:       now,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return record, nil
}

// sessionToolResults 复刻 createGenerationProposal 里对 tool-result parts 的筛选。
func sessionToolResults(parts []db.ListGenerationMessagePartsForReportRoutesRow) ([]map[string]any, []map[string]any) {
	listResults := make([]map[string]any, 0)
	contentResults := make([]map[string]any, 0)
	for _, part := range parts {
		if part.PartType != "tool-result" || len(part.Data) == 0 {
			continue
		}
		var data struct {
			ToolName string          `json:"toolName"`
			Output   json.RawMessage `json:"output"`
		}
		if json.Unmarshal(part.Data, &data) != nil {
			continue
		}
		var output any
		if json.Unmarshal(data.Output, &output) != nil {
			continue
		}
		value, ok := output.(map[string]any)
		if !ok {
			continue
		}
		switch data.ToolName {
		case tools.ReportListToolName:
			if tools.IsReportListToolResult(value) {
				listResults = append(listResults, value)
			}
		case tools.ReportContentToolName:
			if tools.IsReportContentToolResult(value) {
				contentResults = append(contentResults, value)
			}
		}
	}
	return listResults, contentResults
}

// persistQuerySnapshot 复刻 persistQuerySnapshot：派生 count/truncated/errorCode/
// identity，previousSnapshotId 链到同工具上一行；任何失败都折成 nil（TS catch）。
func (e *Engine) persistQuerySnapshot(
	ctx context.Context,
	sessionID int64,
	toolName string,
	parameters any,
	result any,
	durationMs int64,
	trigger string,
	previousSnapshotID *int64,
) *int64 {
	session, err := e.Queries.GetGenerationSessionByIDForGenerationEngine(ctx, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return nil
	}
	parametersText, ok := marshalJSONText(parameters)
	if !ok {
		return nil
	}
	resultText, ok := marshalJSONText(result)
	if !ok {
		return nil
	}

	var parsed map[string]any
	_ = json.Unmarshal([]byte(resultText), &parsed)
	count := int64(0)
	if items, ok := parsed["items"].([]any); ok {
		count = int64(len(items))
	} else if matches, ok := parsed["matches"].([]any); ok {
		count = int64(len(matches))
	} else if found, ok := parsed["found"].(bool); ok && found {
		count = 1
	}
	truncated := int64(0)
	if value, ok := parsed["truncated"].(bool); ok && value {
		truncated = 1
	}
	if value, ok := parsed["matchesTruncated"].(bool); ok && value {
		truncated = 1
	}
	var errorCode *string
	if okValue, _ := parsed["ok"].(bool); !okValue {
		if errorObject, ok := parsed["error"].(map[string]any); ok {
			if code, present := errorObject["code"]; present {
				text := jsString(code)
				errorCode = &text
			}
		}
	}

	identity, _ := parsed["identity"].(map[string]any)
	if identity == nil {
		if items, ok := parsed["items"].([]any); ok && len(items) == 1 {
			identity, _ = items[0].(map[string]any)
		}
	}
	var sourceUpdatedAt *int64
	var sourceWeekStart, sourceWeekEnd, sourceFinalStatus *string
	if identity != nil {
		if value, ok := identity["updatedAt"].(string); ok {
			parsedTime := jsdate.ParseString(value)
			if parsedTime.Valid {
				seconds := parsedTime.Millis / 1000
				sourceUpdatedAt = &seconds
			}
		}
		if value, ok := identity["weekStart"].(string); ok {
			sourceWeekStart = &value
		}
		if value, ok := identity["weekEnd"].(string); ok {
			sourceWeekEnd = &value
		}
		if value, ok := identity["finalStatus"].(string); ok {
			sourceFinalStatus = &value
		}
	}

	previous := previousSnapshotID
	if previous == nil {
		last, err := e.Queries.GetLatestQuerySnapshotForToolForGenerationEngine(ctx, db.GetLatestQuerySnapshotForToolForGenerationEngineParams{
			SessionID: sessionID,
			ToolName:  toolName,
		})
		if err == nil {
			previous = &last
		}
	}

	duration := int64(math.Round(float64(durationMs)))
	if duration < 0 {
		duration = 0
	}
	if trigger == "" {
		trigger = "automatic"
	}
	now := e.now().Unix()
	id, err := e.Queries.InsertGenerationQuerySnapshotForGenerationEngine(ctx, db.InsertGenerationQuerySnapshotForGenerationEngineParams{
		SessionID:          sessionID,
		ToolName:           toolName,
		Parameters:         parametersText,
		CalledAt:           now,
		SourceReportID:     session.ReportID,
		SourceAudience:     session.Variant,
		SourceUpdatedAt:    sourceUpdatedAt,
		SourceWeekStart:    sourceWeekStart,
		SourceWeekEnd:      sourceWeekEnd,
		SourceFinalStatus:  sourceFinalStatus,
		Result:             resultText,
		ResultCount:        count,
		Truncated:          truncated,
		DurationMs:         duration,
		ErrorCode:          errorCode,
		Trigger:            trigger,
		PreviousSnapshotID: previous,
		CreatedAt:          now,
	})
	if err != nil {
		return nil
	}
	return &id
}

// jsString 复刻 `String(value)` 对错误码（字符串或数字）的可观测输出。
func jsString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return jsnum.FormatNumber(typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	default:
		return ""
	}
}
