package reports

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/aiclient"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/engine"
	reportlib "github.com/dev-zapi/weekly-reporter/internal/reports"
)

// 本文件覆盖 B6 生成引擎的 5 条路由 + 一次性终版生成：
//
//	POST /reports/{id}/generate
//	POST /reports/{id}/generation-sessions/{sessionId}/turns
//	POST /reports/{id}/generation-sessions/{sessionId}/turns/{turnId}/stop
//	POST /reports/{id}/generation-sessions/{sessionId}/proposals/{proposalId}/accept
//	POST /reports/{id}/generation-sessions/{sessionId}/query-snapshots/refresh
//
// 行为唯一事实源是 src/app/api/reports/**/route.ts；引擎循环在 internal/engine。

// ndjsonHeaders 是 createGenerationEventStream 的响应头（客户端逐行消费）。
func setNDJSONHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func parseTurnID(r *http.Request) (int64, bool) {
	return jsparse.ParseInt10(chi.URLParam(r, "turnId"))
}

func parseProposalID(r *http.Request) (int64, bool) {
	return jsparse.ParseInt10(chi.URLParam(r, "proposalId"))
}

// failEngineOr 把引擎/服务的业务错误映射成 {error,code}，其余是路由的 500 文案。
func failEngineOr(w http.ResponseWriter, err error, logPrefix, message, code string) {
	var serviceError *engine.ServiceError
	if errors.As(err, &serviceError) {
		respond.Error(w, serviceError.Status, serviceError.Message, serviceError.Code)
		return
	}
	var sessionError *generationServiceError
	if errors.As(err, &sessionError) {
		respond.Error(w, sessionError.Status, sessionError.Message, sessionError.Code)
		return
	}
	log.Printf("%s: %v", logPrefix, err)
	respond.Error(w, http.StatusInternalServerError, message, code)
}

// ---- POST /reports/{id}/generate（一次性终版生成，不经过生成会话）----

var errAINotConfigured = errors.New("AI_API_KEY 未配置")

const generateFinalSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"summary":{"minItems":1,"maxItems":6,"type":"array","items":{"type":"string","minLength":1}},"content":{"type":"string","minLength":1}},"required":["summary","content"],"additionalProperties":false}`

type templateSelectionJSON struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
	AiStyle string `json:"aiStyle"`
}

func generateReportHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			failGenerate(w, err)
			return
		}
		object, isObject := body.(map[string]any)
		if !isObject {
			if body == nil {
				failGenerate(w, errors.New("TypeError: Cannot read properties of null (reading 'variant')"))
				return
			}
			respond.Error(w, http.StatusBadRequest, "Select an audience variant and template", "INVALID_INPUT")
			return
		}

		variant := ""
		if value, present := object["variant"]; present {
			if text, isString := value.(string); isString && (text == "leadership" || text == "personal") {
				variant = text
			}
		}
		templateID, templateIsString := object["templateId"].(string)
		if variant == "" || !templateIsString || templateID == "" {
			respond.Error(w, http.StatusBadRequest, "Select an audience variant and template", "INVALID_INPUT")
			return
		}

		bundle, err := reportlib.GetReportBundle(r.Context(), deps.Queries, reportID)
		if err != nil {
			failGenerate(w, err)
			return
		}
		if bundle == nil {
			respond.Error(w, http.StatusNotFound, "Report not found", "NOT_FOUND")
			return
		}
		reportVariant := findVariantJSON(bundle.Variants, variant)
		if reportVariant == nil {
			respond.Error(w, http.StatusNotFound, "Report variant not found", "VARIANT_NOT_FOUND")
			return
		}
		if reportVariant.SourceRevision == 0 || reportlib.IsEmptySourceDraft(reportVariant.SourceDraft) {
			respond.Error(w, http.StatusBadRequest, "No events are available to generate the final report", "EMPTY_SOURCE_DRAFT")
			return
		}

		template, err := reportlib.GetTemplateSelection(r.Context(), deps.Queries, templateID)
		if err != nil {
			failGenerate(w, err)
			return
		}
		if template == nil {
			respond.Error(w, http.StatusNotFound, "Template not found", "TEMPLATE_NOT_FOUND")
			return
		}

		styleKey := template.AiStyle
		if value, isString := object["styleOverride"].(string); isString && value != "" {
			styleKey = value
		}
		style, err := loadAIStyle(r, deps, styleKey)
		if err != nil {
			failGenerate(w, err)
			return
		}
		temperature, ok := jsnum.ParseFloat(style.Temperature)
		if !ok {
			temperature = math.NaN()
		}

		result, err := generateFinalReport(r, deps, generateFinalReportInput{
			sourceDraft: reportVariant.SourceDraft,
			template:    template.Content,
			variant:     variant,
			weekStart:   bundle.Report.WeekStart,
			weekEnd:     bundle.Report.WeekEnd,
			stylePrompt: style.SystemPrompt,
		}, temperature)
		if err != nil {
			failGenerate(w, err)
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Content        string                `json:"content"`
			Summary        []string              `json:"summary"`
			Variant        string                `json:"variant"`
			Template       templateSelectionJSON `json:"template"`
			AiStyle        string                `json:"aiStyle"`
			SourceRevision int64                 `json:"sourceRevision"`
		}{
			Content: result.content,
			Summary: result.summary,
			Variant: variant,
			Template: templateSelectionJSON{
				ID: template.ID, Name: template.Name, Content: template.Content, AiStyle: template.AiStyle,
			},
			AiStyle:        styleKey,
			SourceRevision: reportVariant.SourceRevision,
		})
	}
}

// failGenerate 复刻 route.ts 的 catch：AIConfigError → 400，其余 500 + details。
func failGenerate(w http.ResponseWriter, err error) {
	if errors.Is(err, errAINotConfigured) {
		respond.Error(w, http.StatusBadRequest, errAINotConfigured.Error(), "AI_NOT_CONFIGURED")
		return
	}
	log.Printf("POST /api/reports/[id]/generate error: %v", err)
	respond.JSON(w, http.StatusInternalServerError, struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details string `json:"details"`
	}{Error: "Failed to generate final report", Code: "GENERATION_ERROR", Details: err.Error()})
}

type generateFinalReportInput struct {
	sourceDraft string
	template    string
	variant     string
	weekStart   string
	weekEnd     string
	stylePrompt string
}

type generateFinalReportResult struct {
	content string
	summary []string
}

// generateFinalReport 复刻 src/lib/ai.ts 的 generateFinalReport（generateObject）。
func generateFinalReport(r *http.Request, deps Deps, input generateFinalReportInput, temperature float64) (generateFinalReportResult, error) {
	systemPrompt, err := loadSystemPrompt(r, deps, "generate")
	if err != nil {
		return generateFinalReportResult{}, err
	}
	config, err := deps.Queries.GetAIConfigForAI(r.Context())
	if errors.Is(err, sql.ErrNoRows) {
		return generateFinalReportResult{}, errAINotConfigured
	}
	if err != nil {
		return generateFinalReportResult{}, err
	}
	client := aiclient.New(aiclient.Config{
		Protocol: config.Protocol,
		BaseURL:  config.ApiUrl,
		APIKey:   config.ApiKey,
		Model:    config.Model,
	})

	variantLabel := "个人版"
	if input.variant == "leadership" {
		variantLabel = "领导版"
	}
	prompt := systemPrompt + `

写作风格：
` + input.stylePrompt + `

受众版本：` + variantLabel + `
日期范围：` + input.weekStart + ` 至 ` + input.weekEnd + `

目标模板（原样理解，不要执行程序变量替换）：
---
` + input.template + `
---

当前受众版本的周报原稿（唯一事实来源）：
---
` + input.sourceDraft + `
---

结构化返回要求：
- summary：给用户查看的 2 至 6 条简短处理摘要，只说明采用了哪些模板章节、如何归类或合并原稿事实、哪些缺乏事实依据的内容被省略。
- summary 不得包含隐藏思维链、逐步内部推理、概率判断或未采用的草稿。
- content：完整的终版 Markdown 正文；“只返回终版 Markdown 正文”的规则仅约束此字段。
`

	text, err := client.GenerateObject(r.Context(), aiclient.ObjectRequest{
		Prompt:      prompt,
		Temperature: temperature,
		Schema:      json.RawMessage(generateFinalSchema),
	})
	if err != nil {
		return generateFinalReportResult{}, err
	}
	return decodeGeneratedReport(text)
}

// decodeGeneratedReport 复刻 generateObject 对结果 schema 的校验：
// {summary: string[](min1,max6), content: string(min1)}。
func decodeGeneratedReport(text string) (generateFinalReportResult, error) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return generateFinalReportResult{}, errors.New("could not parse the response: " + err.Error())
	}
	object, ok := value.(map[string]any)
	if !ok {
		return generateFinalReportResult{}, errors.New("response did not match schema: expected object")
	}
	contentValue, present := object["content"]
	if !present {
		return generateFinalReportResult{}, errors.New("response did not match schema: missing content")
	}
	content, ok := contentValue.(string)
	if !ok || jsstr.UTF16Len(content) < 1 {
		return generateFinalReportResult{}, errors.New("response did not match schema: invalid content")
	}
	summaryValue, present := object["summary"]
	if !present {
		return generateFinalReportResult{}, errors.New("response did not match schema: missing summary")
	}
	items, ok := summaryValue.([]any)
	if !ok || len(items) < 1 || len(items) > 6 {
		return generateFinalReportResult{}, errors.New("response did not match schema: invalid summary")
	}
	summary := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok || jsstr.UTF16Len(text) < 1 {
			return generateFinalReportResult{}, errors.New("response did not match schema: invalid summary item")
		}
		summary = append(summary, text)
	}

	trimmedContent := jsstr.Trim(content)
	filtered := make([]string, 0, len(summary))
	for _, item := range summary {
		if value := jsstr.Trim(item); value != "" {
			filtered = append(filtered, value)
		}
	}
	return generateFinalReportResult{content: trimmedContent, summary: filtered}, nil
}

// ---- POST …/turns（NDJSON 生成流）----

func turnsHandler(deps Deps, generator *engine.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		if !reportOK || !sessionOK {
			respond.Error(w, http.StatusBadRequest, "Invalid ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("generation turn route error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to start AI generation", "GENERATION_START_ERROR")
			return
		}
		var message string
		if object, isObject := body.(map[string]any); isObject {
			message, _ = object["message"].(string)
		} else if body == nil {
			// `body.message` on null is a TypeError → route.ts 的 500 分支。
			log.Printf("generation turn route error: TypeError: Cannot read properties of null (reading 'message')")
			respond.Error(w, http.StatusInternalServerError, "Failed to start AI generation", "GENERATION_START_ERROR")
			return
		}
		if message == "" || jsstr.Trim(message) == "" {
			respond.Error(w, http.StatusBadRequest, "Message is required", "EMPTY_MESSAGE")
			return
		}

		prepared, err := generator.PrepareTurn(r.Context(), reportID, sessionID, message)
		if err != nil {
			failEngineOr(w, err, "generation turn route error", "Failed to start AI generation", "GENERATION_START_ERROR")
			return
		}

		setNDJSONHeaders(w)
		generator.StreamTurn(w, r, prepared)
	}
}

// ---- POST …/turns/{turnId}/stop ----/

func stopTurnHandler(deps Deps, generator *engine.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		turnID, turnOK := parseTurnID(r)
		if !reportOK || !sessionOK || !turnOK {
			respond.Error(w, http.StatusBadRequest, "无效的ID", "INVALID_ID")
			return
		}

		detail, err := getGenerationSessionDetail(r, deps, reportID, sessionID)
		if err != nil {
			log.Printf("stop generation turn error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "停止生成失败", "STOP_ERROR")
			return
		}
		found := false
		if detail != nil {
			for _, turn := range detail.Turns {
				if turn.ID == turnID {
					found = true
					break
				}
			}
		}
		if !found {
			respond.Error(w, http.StatusNotFound, "生成轮次不存在", "TURN_NOT_FOUND")
			return
		}

		turn, err := generator.StopTurn(r.Context(), turnID)
		if err != nil {
			failEngineOr(w, err, "stop generation turn error", "停止生成失败", "STOP_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, turnToJSON(*turn))
	}
}

// ---- POST …/proposals/{proposalId}/accept ----/

type acceptProposalResult struct {
	Session  generationSessionJSON  `json:"session"`
	Proposal generationProposalJSON `json:"proposal"`
	Variant  reportlib.VariantJSON  `json:"variant"`
}

func acceptProposalHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		proposalID, proposalOK := parseProposalID(r)
		if !reportOK || !sessionOK || !proposalOK {
			respond.Error(w, http.StatusBadRequest, "无效的ID", "INVALID_ID")
			return
		}

		result, err := acceptGenerationProposal(r.Context(), deps, reportID, sessionID, proposalID)
		if err != nil {
			failEngineOr(w, err, "accept generation proposal error", "保存候选终版失败", "ACCEPT_PROPOSAL_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, result)
	}
}

// acceptGenerationProposal 复刻 service.ts 的 acceptGenerationProposal 事务。
func acceptGenerationProposal(ctx context.Context, deps Deps, reportID, sessionID, proposalID int64) (*acceptProposalResult, error) {
	var result *acceptProposalResult
	err := deps.Queries.InTx(ctx, func(tx *db.Queries) error {
		session, err := tx.GetGenerationSessionForReportRoutes(ctx, db.GetGenerationSessionForReportRoutesParams{
			ID:       sessionID,
			ReportID: reportID,
		})
		if errors.Is(err, sql.ErrNoRows) {
			return &generationServiceError{Message: "Generation session not found", Code: "SESSION_NOT_FOUND", Status: http.StatusNotFound}
		}
		if err != nil {
			return err
		}
		proposal, err := tx.GetGenerationProposalByIDForGenerationEngine(ctx, db.GetGenerationProposalByIDForGenerationEngineParams{
			ID:        proposalID,
			SessionID: sessionID,
		})
		if errors.Is(err, sql.ErrNoRows) {
			return &generationServiceError{Message: "Proposal not found", Code: "PROPOSAL_NOT_FOUND", Status: http.StatusNotFound}
		}
		if err != nil {
			return err
		}
		if proposal.Status == "superseded" {
			return &generationServiceError{Message: "This proposal has been superseded", Code: "PROPOSAL_SUPERSEDED", Status: http.StatusConflict}
		}

		variants, err := tx.ListReportVariantsForReportRoutes(ctx, db.ListReportVariantsForReportRoutesParams{
			IDFilter:     int64(1),
			ID:           session.ReportVariantID,
			ReportFilter: int64(0),
		})
		if err != nil {
			return err
		}
		var currentVariant *db.ListReportVariantsForReportRoutesRow
		for index := range variants {
			if variants[index].ID == session.ReportVariantID {
				currentVariant = &variants[index]
				break
			}
		}
		if currentVariant == nil ||
			currentVariant.SourceRevision != session.SourceRevision ||
			proposal.SourceRevision != session.SourceRevision {
			return &generationServiceError{
				Message: "The source draft changed; start a new session from the latest draft",
				Code:    "SOURCE_REVISION_CONFLICT",
				Status:  http.StatusConflict,
			}
		}

		now := nowUnix()
		content := proposal.Content
		if err := tx.UpdateReportVariantAcceptedForGenerationEngine(ctx, db.UpdateReportVariantAcceptedForGenerationEngineParams{
			FinalContent:       &content,
			TemplateID:         &session.TemplateID,
			TemplateName:       &session.TemplateName,
			TemplateContent:    &session.TemplateContent,
			AiStyle:            &session.AiStyleKey,
			AcceptedProposalID: &proposal.ID,
			UpdatedAt:          now,
			ID:                 currentVariant.ID,
		}); err != nil {
			return err
		}
		if err := tx.UpdateGenerationProposalAcceptedForGenerationEngine(ctx, db.UpdateGenerationProposalAcceptedForGenerationEngineParams{
			AcceptedAt: &now,
			ID:         proposal.ID,
		}); err != nil {
			return err
		}
		if session.Variant == "personal" {
			if _, err := tx.UpdateReportContentForReportRoutes(ctx, db.UpdateReportContentForReportRoutesParams{
				Content:   content,
				UpdatedAt: now,
				ID:        reportID,
			}); err != nil {
				return err
			}
		}
		if err := tx.UpdateGenerationSessionBaselineForReportRoutes(ctx, db.UpdateGenerationSessionBaselineForReportRoutesParams{
			BaselineFinalContent: &content,
			UpdatedAt:            now,
			ID:                   session.ID,
		}); err != nil {
			return err
		}

		sequence := int64(0)
		latest, err := tx.GetLatestGenerationMessageSequenceForReportRoutes(ctx, session.ID)
		if err == nil {
			sequence = latest
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		acceptedContent := "用户已确认并保存该候选终版。"
		data, _ := json.Marshal(map[string]any{"proposalId": proposal.ID})
		dataText := string(data)
		if err := tx.InsertGenerationMessagePartForReportRoutes(ctx, db.InsertGenerationMessagePartForReportRoutesParams{
			SessionID: session.ID,
			TurnID:    nil,
			Sequence:  sequence + 1,
			Role:      "application",
			PartType:  "proposal-accepted",
			Content:   &acceptedContent,
			Data:      &dataText,
			CreatedAt: now,
		}); err != nil {
			return err
		}

		acceptedAt := reportlib.ISOStringFromUnix(now)
		proposalJSON := generationProposalJSON{
			ID:              proposal.ID,
			SessionID:       proposal.SessionID,
			TurnID:          proposal.TurnID,
			Content:         proposal.Content,
			Summary:         reportlib.JSONColumn(proposal.Summary),
			SourceRevision:  proposal.SourceRevision,
			Status:          "accepted",
			PlanState:       reportlib.JSONColumn(proposal.PlanState),
			PublicSummary:   reportlib.JSONColumn(proposal.PublicSummary),
			BaselineContent: proposal.BaselineContent,
			CreatedAt:       reportlib.ISOStringFromUnix(proposal.CreatedAt),
			AcceptedAt:      &acceptedAt,
		}
		updatedAt := reportlib.ISOStringFromUnix(now)
		acceptedProposalID := proposal.ID
		aiStyle := session.AiStyleKey
		result = &acceptProposalResult{
			Session:  sessionToJSON(session),
			Proposal: proposalJSON,
			Variant: reportlib.VariantJSON{
				ID:                        currentVariant.ID,
				ReportID:                  currentVariant.ReportID,
				Variant:                   currentVariant.Variant,
				SourceDraft:               currentVariant.SourceDraft,
				FinalContent:              &content,
				FinalStatus:               "current",
				TemplateID:                &session.TemplateID,
				TemplateName:              &session.TemplateName,
				TemplateContent:           &session.TemplateContent,
				StructureCompletenessRule: reportlib.JSONColumn(currentVariant.StructureCompletenessRule),
				AiStyle:                   &aiStyle,
				AcceptedProposalID:        &acceptedProposalID,
				SourceRevision:            currentVariant.SourceRevision,
				CreatedAt:                 reportlib.ISOStringFromUnix(currentVariant.CreatedAt),
				UpdatedAt:                 updatedAt,
			},
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ---- POST …/query-snapshots/refresh ----/

func refreshQuerySnapshotHandler(deps Deps, generator *engine.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		if !reportOK || !sessionOK {
			respond.Error(w, http.StatusBadRequest, "Invalid ID", "INVALID_ID")
			return
		}

		// `await request.json().catch(() => ({}))`：解析失败按空对象处理。
		snapshotID := int64(0)
		if body, err := jsjson.DecodeBody(r); err == nil {
			if object, isObject := body.(map[string]any); isObject {
				snapshotID = snapshotIDValue(object["snapshotId"])
			}
		}

		snapshot, err := generator.RefreshHistoricalQuery(r.Context(), reportID, sessionID, snapshotID)
		if err != nil {
			failEngineOr(w, err, "refresh historical query error", "Failed to refresh historical query", "QUERY_REFRESH_FAILED")
			return
		}
		if snapshot == nil {
			respond.JSON(w, http.StatusOK, json.RawMessage("null"))
			return
		}
		respond.JSON(w, http.StatusOK, snapshot)
	}
}

// snapshotIDValue 复刻 `body.snapshotId ?? 0` 对 JSON 数字的绑定。
func snapshotIDValue(value any) int64 {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
		return 0
	}
	if number < math.MinInt64 || number > math.MaxInt64 {
		return 0
	}
	return int64(number)
}
