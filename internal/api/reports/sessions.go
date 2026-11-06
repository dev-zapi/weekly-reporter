package reports

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/aiseed"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	generationlib "github.com/dev-zapi/weekly-reporter/internal/generation"
	reportlib "github.com/dev-zapi/weekly-reporter/internal/reports"
)

// 本文件覆盖 /api/reports/{id}/generation-sessions 的读面与生命周期
// （列表 / 新建 / 详情 / 改名 / 归档）。轮次与提案的写路径（turns / stop /
// accept / query-snapshots）由同批的引擎票注册。
//
// 语义事实源是 src/app/api/reports/[id]/generation-sessions/**/route.ts 与
// src/lib/generation/service.ts 的对应函数。

// generationServiceError 对应 TS 的 GenerationServiceError：{error: message,
// code, status}。
type generationServiceError struct {
	Message string
	Code    string
	Status  int
}

func (e *generationServiceError) Error() string { return e.Message }

func failGeneration(w http.ResponseWriter, err error) {
	var serviceError *generationServiceError
	if errors.As(err, &serviceError) {
		failWithCode(w, serviceError.Status, serviceError.Message, serviceError.Code)
		return
	}
	log.Printf("generation session route error: %v", err)
	failWithCode(w, http.StatusInternalServerError, "Generation session operation failed", "GENERATION_SESSION_ERROR")
}

// ---- 响应形状 ----

// generationTurnJSON 是 generation_turns 行的响应形状。
type generationTurnJSON struct {
	ID              int64   `json:"id"`
	SessionID       int64   `json:"sessionId"`
	Status          string  `json:"status"`
	Protocol        string  `json:"protocol"`
	Model           string  `json:"model"`
	ReasoningEffort *string `json:"reasoningEffort"`
	Error           *string `json:"error"`
	CreatedAt       string  `json:"createdAt"`
	FinishedAt      *string `json:"finishedAt"`
}

func turnToJSON(row db.GenerationTurn) generationTurnJSON {
	var finishedAt *string
	if row.FinishedAt != nil {
		value := reportlib.ISOStringFromUnix(*row.FinishedAt)
		finishedAt = &value
	}
	return generationTurnJSON{
		ID:              row.ID,
		SessionID:       row.SessionID,
		Status:          row.Status,
		Protocol:        row.Protocol,
		Model:           row.Model,
		ReasoningEffort: row.ReasoningEffort,
		Error:           row.Error,
		CreatedAt:       reportlib.ISOStringFromUnix(row.CreatedAt),
		FinishedAt:      finishedAt,
	}
}

// generationProposalJSON 是 generation_proposals 行的响应形状。
//
// PlanState 是 ADR-0021 之前的历史列，历史行仍要原样回给客户端；PublicSummary
// 会在列表/详情里经过 normalizePublicGenerationSummary。
type generationProposalJSON struct {
	ID              int64           `json:"id"`
	SessionID       int64           `json:"sessionId"`
	TurnID          int64           `json:"turnId"`
	Content         string          `json:"content"`
	Summary         json.RawMessage `json:"summary"`
	SourceRevision  int64           `json:"sourceRevision"`
	Status          string          `json:"status"`
	PlanState       json.RawMessage `json:"planState"`
	PublicSummary   json.RawMessage `json:"publicSummary"`
	BaselineContent *string         `json:"baselineContent"`
	CreatedAt       string          `json:"createdAt"`
	AcceptedAt      *string         `json:"acceptedAt"`
}

func proposalToJSON(row db.ListGenerationProposalsForReportRoutesRow) generationProposalJSON {
	var acceptedAt *string
	if row.AcceptedAt != nil {
		value := reportlib.ISOStringFromUnix(*row.AcceptedAt)
		acceptedAt = &value
	}
	return generationProposalJSON{
		ID:              row.ID,
		SessionID:       row.SessionID,
		TurnID:          row.TurnID,
		Content:         row.Content,
		Summary:         reportlib.JSONColumn(row.Summary),
		SourceRevision:  row.SourceRevision,
		Status:          row.Status,
		PlanState:       reportlib.JSONColumn(row.PlanState),
		PublicSummary:   reportlib.JSONColumn(row.PublicSummary),
		BaselineContent: row.BaselineContent,
		CreatedAt:       reportlib.ISOStringFromUnix(row.CreatedAt),
		AcceptedAt:      acceptedAt,
	}
}

// generationSessionJSON 是 generation_sessions 行的响应形状。
type generationSessionJSON struct {
	ID                   int64   `json:"id"`
	ReportID             int64   `json:"reportId"`
	ReportVariantID      int64   `json:"reportVariantId"`
	Variant              string  `json:"variant"`
	Title                string  `json:"title"`
	Status               string  `json:"status"`
	SourceRevision       int64   `json:"sourceRevision"`
	SourceDraftSnapshot  string  `json:"sourceDraftSnapshot"`
	SourceOverview       string  `json:"sourceOverview"`
	TemplateID           string  `json:"templateId"`
	TemplateName         string  `json:"templateName"`
	TemplateContent      string  `json:"templateContent"`
	AiStyleKey           string  `json:"aiStyleKey"`
	AiStyleLabel         string  `json:"aiStyleLabel"`
	AiStylePrompt        string  `json:"aiStylePrompt"`
	Temperature          string  `json:"temperature"`
	SystemPrompt         string  `json:"systemPrompt"`
	ToolRules            string  `json:"toolRules"`
	PlanPolicy           *string `json:"planPolicy"`
	BaselineFinalContent *string `json:"baselineFinalContent"`
	CarryForwardSnapshot *string `json:"carryForwardSnapshot"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            string  `json:"updatedAt"`
	ArchivedAt           *string `json:"archivedAt"`
}

func sessionToJSON(row db.GenerationSession) generationSessionJSON {
	var archivedAt *string
	if row.ArchivedAt != nil {
		value := reportlib.ISOStringFromUnix(*row.ArchivedAt)
		archivedAt = &value
	}
	return generationSessionJSON{
		ID:                   row.ID,
		ReportID:             row.ReportID,
		ReportVariantID:      row.ReportVariantID,
		Variant:              row.Variant,
		Title:                row.Title,
		Status:               row.Status,
		SourceRevision:       row.SourceRevision,
		SourceDraftSnapshot:  row.SourceDraftSnapshot,
		SourceOverview:       row.SourceOverview,
		TemplateID:           row.TemplateID,
		TemplateName:         row.TemplateName,
		TemplateContent:      row.TemplateContent,
		AiStyleKey:           row.AiStyleKey,
		AiStyleLabel:         row.AiStyleLabel,
		AiStylePrompt:        row.AiStylePrompt,
		Temperature:          row.Temperature,
		SystemPrompt:         row.SystemPrompt,
		ToolRules:            row.ToolRules,
		PlanPolicy:           row.PlanPolicy,
		BaselineFinalContent: row.BaselineFinalContent,
		CarryForwardSnapshot: row.CarryForwardSnapshot,
		CreatedAt:            reportlib.ISOStringFromUnix(row.CreatedAt),
		UpdatedAt:            reportlib.ISOStringFromUnix(row.UpdatedAt),
		ArchivedAt:           archivedAt,
	}
}

// sessionSummaryJSON 是列表元素：会话行 + 最新轮次 + 最新提案。
type sessionSummaryJSON struct {
	generationSessionJSON
	LatestTurn     *generationTurnJSON     `json:"latestTurn"`
	LatestProposal *generationProposalJSON `json:"latestProposal"`
}

// withPublicSummary 把提案的 publicSummary 换成 normalize 后的结果（不可解析时 null）。
func withPublicSummary(proposal generationProposalJSON) generationProposalJSON {
	proposal.PublicSummary = generationlib.NormalizePublicGenerationSummary(proposal.PublicSummary)
	return proposal
}

// ---- 列表 / 新建 ----

func listSessionsHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			failWithCode(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		// `variant === 'leadership' || variant === 'personal' ? variant : undefined`
		rawVariant := r.URL.Query().Get("variant")
		var variant string
		if rawVariant == "leadership" || rawVariant == "personal" {
			variant = rawVariant
		}

		sessions, err := deps.Queries.ListGenerationSessionsForReportRoutes(r.Context(), db.ListGenerationSessionsForReportRoutesParams{
			ReportID:      reportID,
			VariantFilter: boolFlag(variant != ""),
			Variant:       variant,
		})
		if err != nil {
			failGeneration(w, err)
			return
		}

		items := make([]sessionSummaryJSON, 0, len(sessions))
		for _, session := range sessions {
			summary := sessionSummaryJSON{generationSessionJSON: sessionToJSON(session)}

			latestTurn, err := deps.Queries.GetLatestGenerationTurnForReportRoutes(r.Context(), session.ID)
			if err == nil {
				turn := turnToJSON(latestTurn)
				summary.LatestTurn = &turn
			} else if !errors.Is(err, sql.ErrNoRows) {
				failGeneration(w, err)
				return
			}

			proposals, err := deps.Queries.ListGenerationProposalsForReportRoutes(r.Context(), db.ListGenerationProposalsForReportRoutesParams{
				IDFilter:      int64(0),
				SessionFilter: boolFlag(true),
				SessionID:     session.ID,
			})
			if err != nil {
				failGeneration(w, err)
				return
			}
			if len(proposals) > 0 {
				// `orderBy(desc(id)).limit(1)`
				proposal := withPublicSummary(proposalToJSON(proposals[len(proposals)-1]))
				summary.LatestProposal = &proposal
			}

			items = append(items, summary)
		}

		respond.JSON(w, http.StatusOK, struct {
			Sessions []sessionSummaryJSON `json:"sessions"`
		}{Sessions: items})
	}
}

func createSessionHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			failWithCode(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			failGeneration(w, err)
			return
		}
		object, isObject := body.(map[string]any)
		if !isObject {
			if body == nil {
				// `body.variant` 在 null 上是 TypeError，route.ts 的 catch 回 500。
				failGeneration(w, errors.New("TypeError: Cannot read properties of null (reading 'variant')"))
				return
			}
			// 原始值上取属性得到 undefined，落进 INVALID_INPUT 校验分支。
			failWithCode(w, http.StatusBadRequest, "Select an audience variant and template", "INVALID_INPUT")
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
			failWithCode(w, http.StatusBadRequest, "Select an audience variant and template", "INVALID_INPUT")
			return
		}

		styleOverride := ""
		if value, present := object["styleOverride"]; present {
			if text, isString := value.(string); isString {
				styleOverride = text
			}
		}

		session, err := createGenerationSession(r, deps, reportID, variant, templateID, styleOverride)
		if err != nil {
			failGeneration(w, err)
			return
		}
		respond.JSON(w, http.StatusCreated, session)
	}
}

// createGenerationSession 复刻 src/lib/generation/service.ts 的同名函数。
//
// 与 TS 的差别只有一处（不可观测）：TS 用 `Intl.DateTimeFormat(undefined, {...})`
// 生成会话标题里的时间标签，输出形态取决于进程 locale。Go 侧按 en-US 的
// `MM/DD, HH:mm` 形态固定输出——服务进程与 Next 进程在同一台机器、同一 locale
// 下运行时两者一致，标题本身也只作展示。
func createGenerationSession(r *http.Request, deps Deps, reportID int64, variant, templateID, styleOverride string) (generationSessionJSON, error) {
	bundle, err := reportlib.GetReportBundle(r.Context(), deps.Queries, reportID)
	if err != nil {
		return generationSessionJSON{}, err
	}
	if bundle == nil {
		return generationSessionJSON{}, &generationServiceError{Message: "Report not found", Code: "REPORT_NOT_FOUND", Status: http.StatusNotFound}
	}

	template, err := reportlib.GetTemplateSelection(r.Context(), deps.Queries, templateID)
	if err != nil {
		return generationSessionJSON{}, err
	}
	if template == nil {
		return generationSessionJSON{}, &generationServiceError{Message: "Template not found", Code: "TEMPLATE_NOT_FOUND", Status: http.StatusNotFound}
	}

	reportVariant := findVariantJSON(bundle.Variants, variant)
	if reportVariant == nil {
		return generationSessionJSON{}, &generationServiceError{Message: "Report variant not found", Code: "VARIANT_NOT_FOUND", Status: http.StatusNotFound}
	}
	if reportVariant.SourceRevision == 0 || reportlib.IsEmptySourceDraft(reportVariant.SourceDraft) {
		return generationSessionJSON{}, &generationServiceError{Message: "No events are available to generate the final report", Code: "EMPTY_SOURCE_DRAFT", Status: http.StatusBadRequest}
	}

	styleKey := styleOverride
	if styleKey == "" {
		styleKey = template.AiStyle
	}
	if styleKey == "" {
		styleKey = "formal"
	}
	style, err := loadAIStyle(r, deps, styleKey)
	if err != nil {
		return generationSessionJSON{}, err
	}

	basePrompt, err := loadSystemPrompt(r, deps, "generate")
	if err != nil {
		return generationSessionJSON{}, err
	}

	now := nowUnix()
	nowTime := timeFromUnix(now)
	timeLabel := formatSessionTimeLabel(nowTime)
	systemPrompt := generationlib.BuildEffectiveGenerationSystemPrompt(basePrompt)

	var created db.GenerationSession
	err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
		session, err := tx.InsertGenerationSessionForReportRoutes(r.Context(), db.InsertGenerationSessionForReportRoutesParams{
			ReportID:             reportID,
			ReportVariantID:      reportVariant.ID,
			Variant:              variant,
			Title:                template.Name + " · " + timeLabel,
			SourceRevision:       reportVariant.SourceRevision,
			SourceDraftSnapshot:  reportVariant.SourceDraft,
			SourceOverview:       generationlib.BuildSourceOverview(reportVariant.SourceDraft, variant),
			TemplateID:           template.ID,
			TemplateName:         template.Name,
			TemplateContent:      template.Content,
			AiStyleKey:           styleKey,
			AiStyleLabel:         style.Label,
			AiStylePrompt:        style.SystemPrompt,
			Temperature:          style.Temperature,
			SystemPrompt:         systemPrompt,
			ToolRules:            generationlib.FinalReportToolRules,
			BaselineFinalContent: reportVariant.FinalContent,
			CreatedAt:            now,
			UpdatedAt:            now,
		})
		if err != nil {
			return err
		}
		created = session

		parts := []struct {
			sequence int64
			role     string
			partType string
			content  string
			data     *string
		}{
			{1, "system", "system-prompt", session.SystemPrompt, nil},
			{2, "system", "style-prompt", session.AiStylePrompt, stringPointer(`{"key":` + jsonString(session.AiStyleKey) + `,"label":` + jsonString(session.AiStyleLabel) + `}`)},
			{3, "system", "tool-rules", session.ToolRules, nil},
			{4, "system", "source-overview", session.SourceOverview, nil},
		}
		for _, part := range parts {
			content := part.content
			if err := tx.InsertGenerationMessagePartForReportRoutes(r.Context(), db.InsertGenerationMessagePartForReportRoutesParams{
				SessionID: session.ID,
				TurnID:    nil,
				Sequence:  part.sequence,
				Role:      part.role,
				PartType:  part.partType,
				Content:   &content,
				Data:      part.data,
				CreatedAt: now,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return generationSessionJSON{}, err
	}
	return sessionToJSON(created), nil
}

// ---- 详情 / 改名 / 归档 ----

// sessionDetailJSON 是详情响应：会话行 + messages/turns/proposals + 快照与派生标记。
type sessionDetailJSON struct {
	generationSessionJSON
	Messages                    []messagePartJSON                 `json:"messages"`
	Turns                       []generationTurnJSON              `json:"turns"`
	Proposals                   []proposalDetailJSON              `json:"proposals"`
	QuerySnapshots              []generationlib.QuerySnapshotJSON `json:"querySnapshots"`
	HistoricalReferencesChanged bool                              `json:"historicalReferencesChanged"`
	SourceIsCurrent             bool                              `json:"sourceIsCurrent"`
	ActiveTurn                  *generationTurnJSON               `json:"activeTurn"`
}

type proposalDetailJSON struct {
	generationProposalJSON
	ReferenceChanged *bool `json:"referenceChanged"`
}

func getSessionHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		if !reportOK || !sessionOK {
			failWithCode(w, http.StatusBadRequest, "Invalid ID", "INVALID_ID")
			return
		}

		detail, err := getGenerationSessionDetail(r, deps, reportID, sessionID)
		if err != nil {
			failGeneration(w, err)
			return
		}
		if detail == nil {
			failWithCode(w, http.StatusNotFound, "Generation session not found", "SESSION_NOT_FOUND")
			return
		}
		respond.JSON(w, http.StatusOK, detail)
	}
}

// getGenerationSessionDetail 复刻 src/lib/generation/service.ts 的同名函数。
func getGenerationSessionDetail(r *http.Request, deps Deps, reportID, sessionID int64) (*sessionDetailJSON, error) {
	session, err := deps.Queries.GetGenerationSessionForReportRoutes(r.Context(), db.GetGenerationSessionForReportRoutesParams{
		ID:       sessionID,
		ReportID: reportID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	messageRows, err := deps.Queries.ListGenerationMessagePartsForReportRoutes(r.Context(), session.ID)
	if err != nil {
		return nil, err
	}
	turnRows, err := deps.Queries.ListGenerationTurnsForReportRoutes(r.Context(), session.ID)
	if err != nil {
		return nil, err
	}
	proposalRows, err := deps.Queries.ListGenerationProposalsForReportRoutes(r.Context(), db.ListGenerationProposalsForReportRoutesParams{
		IDFilter:      int64(0),
		SessionFilter: boolFlag(true),
		SessionID:     session.ID,
	})
	if err != nil {
		return nil, err
	}
	currentVariant, err := variantByID(r, deps, session.ReportVariantID)
	if err != nil {
		return nil, err
	}
	snapshots, err := generationlib.ListQuerySnapshots(r.Context(), deps.Queries, session.ID)
	if err != nil {
		// listQuerySnapshots 在 TS 里用 try/catch 折成空数组。
		log.Printf("generation session snapshots error: %v", err)
		snapshots = []generationlib.QuerySnapshotJSON{}
	}

	messages := make([]messagePartJSON, 0, len(messageRows))
	for _, row := range messageRows {
		messages = append(messages, messagePartToJSON(row))
	}
	turns := make([]generationTurnJSON, 0, len(turnRows))
	var activeTurn *generationTurnJSON
	for _, row := range turnRows {
		turn := turnToJSON(row)
		turns = append(turns, turn)
		if turn.Status == "working" && activeTurn == nil {
			copied := turn
			activeTurn = &copied
		}
	}

	proposals := make([]proposalDetailJSON, 0, len(proposalRows))
	historicalChanged := false
	for _, row := range proposalRows {
		proposal := withPublicSummary(proposalToJSON(row))
		changed := generationlib.ProposalReferenceChanged(proposal.Status, proposal.CreatedAt, snapshots)
		if changed {
			historicalChanged = true
		}
		value := changed
		proposals = append(proposals, proposalDetailJSON{generationProposalJSON: proposal, ReferenceChanged: &value})
	}

	detail := &sessionDetailJSON{
		generationSessionJSON:       sessionToJSON(session),
		Messages:                    messages,
		Turns:                       turns,
		Proposals:                   proposals,
		QuerySnapshots:              snapshots,
		HistoricalReferencesChanged: historicalChanged,
		SourceIsCurrent:             currentVariant != nil && currentVariant.SourceRevision == session.SourceRevision,
		ActiveTurn:                  activeTurn,
	}
	return detail, nil
}

func renameSessionHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		if !reportOK || !sessionOK {
			failWithCode(w, http.StatusBadRequest, "Invalid ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			failGeneration(w, err)
			return
		}
		object, isObject := body.(map[string]any)
		if !isObject {
			if body == nil {
				// `body.title` 在 null 上是 TypeError，route.ts 的 catch 回 500。
				failGeneration(w, errors.New("TypeError: Cannot read properties of null (reading 'title')"))
				return
			}
			failWithCode(w, http.StatusBadRequest, "Session title is required", "INVALID_TITLE")
			return
		}
		title, isString := object["title"].(string)
		if !isString {
			failWithCode(w, http.StatusBadRequest, "Session title is required", "INVALID_TITLE")
			return
		}

		trimmed := trimJS(title)
		if trimmed == "" {
			failWithCode(w, http.StatusBadRequest, "Session title is required", "INVALID_TITLE")
			return
		}
		// `trimmed.slice(0, 120)`：slice 的边界是 UTF-16 码元。
		clipped := reportlib.SliceUTF16(trimmed, 120)

		updated, err := deps.Queries.UpdateGenerationSessionTitleForReportRoutes(r.Context(), db.UpdateGenerationSessionTitleForReportRoutesParams{
			Title:     clipped,
			UpdatedAt: nowUnix(),
			ID:        sessionID,
			ReportID:  reportID,
		})
		if errors.Is(err, sql.ErrNoRows) {
			failWithCode(w, http.StatusNotFound, "Generation session not found", "SESSION_NOT_FOUND")
			return
		}
		if err != nil {
			failGeneration(w, err)
			return
		}
		respond.JSON(w, http.StatusOK, sessionToJSON(updated))
	}
}

func archiveSessionHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, reportOK := parseReportID(r)
		sessionID, sessionOK := parseSessionID(r)
		if !reportOK || !sessionOK {
			failWithCode(w, http.StatusBadRequest, "无效的ID", "INVALID_ID")
			return
		}

		working, err := deps.Queries.GetWorkingGenerationTurnForReportRoutes(r.Context(), sessionID)
		if err == nil && working.ID != 0 {
			failWithCode(w, http.StatusConflict, "AI is still generating; stop the current turn first", "TURN_IN_PROGRESS")
			return
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			failGeneration(w, err)
			return
		}

		now := nowUnix()
		updated, err := deps.Queries.ArchiveGenerationSessionForReportRoutes(r.Context(), db.ArchiveGenerationSessionForReportRoutesParams{
			ArchivedAt: &now,
			UpdatedAt:  now,
			ID:         sessionID,
			ReportID:   reportID,
		})
		if errors.Is(err, sql.ErrNoRows) {
			failWithCode(w, http.StatusNotFound, "Generation session not found", "SESSION_NOT_FOUND")
			return
		}
		if err != nil {
			failGeneration(w, err)
			return
		}
		respond.JSON(w, http.StatusOK, sessionToJSON(updated))
	}
}

// ---- 小工具 ----

// boolFlag 把 bool 折成 sqlc 的模式标志（`?N = 0` 的命名参数）。
func boolFlag(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func stringPointer(value string) *string { return &value }

func jsonString(value string) string {
	// JSON.stringify 不转义 <,>,&；Go 的 json.Marshal 默认会，所以关掉 HTML 转义。
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimRight(buffer.String(), "\n")
}

func findVariantJSON(variants []reportlib.VariantJSON, variant string) *reportlib.VariantJSON {
	for i := range variants {
		if variants[i].Variant == variant {
			return &variants[i]
		}
	}
	return nil
}

func variantByID(r *http.Request, deps Deps, variantID int64) (*reportlib.VariantJSON, error) {
	rows, err := deps.Queries.ListReportVariantsForReportRoutes(r.Context(), db.ListReportVariantsForReportRoutesParams{
		IDFilter:     boolFlag(true),
		ID:           variantID,
		ReportFilter: int64(0),
	})
	if err != nil {
		return nil, err
	}
	for _, variant := range reportlib.VariantsToJSON(rows) {
		if variant.ID == variantID {
			return &variant, nil
		}
	}
	return nil, nil
}

// formatSessionTimeLabel 复刻会话标题里的时间标签。
//
// TS 是 `new Intl.DateTimeFormat(undefined, {month:'2-digit', day:'2-digit',
// hour:'2-digit', minute:'2-digit', hour12:false})`：在 en-US 下输出
// `MM/DD, HH:mm`（例如 `08/17, 14:05`，小时可能是 `24` 形态的边界由 ICU 决定，
// 这里按 00–23 输出）。服务进程与 Next 进程共用同一 locale，形态一致。
func formatSessionTimeLabel(instant time.Time) string {
	local := instant.In(time.Local)
	return padTwo(int(local.Month())) + "/" + padTwo(local.Day()) + ", " + padTwo(local.Hour()) + ":" + padTwo(local.Minute())
}

func padTwo(value int) string {
	if value < 10 {
		return "0" + strconv.Itoa(value)
	}
	return strconv.Itoa(value)
}

// messagePartJSON 是 generation_message_parts 行的响应形状（详情页用）。
type messagePartJSON struct {
	ID        int64           `json:"id"`
	SessionID int64           `json:"sessionId"`
	TurnID    *int64          `json:"turnId"`
	Sequence  int64           `json:"sequence"`
	Role      string          `json:"role"`
	PartType  string          `json:"partType"`
	Content   *string         `json:"content"`
	Data      json.RawMessage `json:"data"`
	CreatedAt string          `json:"createdAt"`
}

func messagePartToJSON(row db.ListGenerationMessagePartsForReportRoutesRow) messagePartJSON {
	return messagePartJSON{
		ID:        row.ID,
		SessionID: row.SessionID,
		TurnID:    row.TurnID,
		Sequence:  row.Sequence,
		Role:      row.Role,
		PartType:  row.PartType,
		Content:   row.Content,
		Data:      reportlib.JSONColumn(row.Data),
		CreatedAt: reportlib.ISOStringFromUnix(row.CreatedAt),
	}
}

// loadSystemPrompt 复刻 src/lib/ai.ts 的 getSystemPrompt(key)：
// 先查 system_prompts，缺行时回退到硬编码文本（两份内容与 seed 一致）。
func loadSystemPrompt(r *http.Request, deps Deps, key string) (string, error) {
	row, err := deps.Queries.GetSystemPromptForPromptRoutes(r.Context(), key)
	if err == nil {
		return row.PromptText, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	switch key {
	case "check":
		return builtinCheckPrompt, nil
	case "generate":
		return builtinGeneratePrompt, nil
	}
	return "", errors.New("Unknown system prompt key: " + key)
}

// aiStyle 是 getAIStyle 用到的三个字段。
type aiStyle struct {
	Label        string
	SystemPrompt string
	Temperature  string
}

// loadAIStyle 复刻 src/lib/ai/styles.ts 的 getAIStyle(styleKey?)：
// 先按 key 查，查不到回退 is_default 行，最后回退硬编码的「正式汇报」。
//
// 与 TS 的差别只有一处（不可观测）：ensureSeed() 在这里不移植——报告的创建会话
// 路径不写 ai_styles（提示词域与 ai 域各自负责 seed），而空库时 TS 的
// ensureSeed 也会先 seed 出同一组内置风格再命中「formal」。两者落到的 systemPrompt
// 与 temperature 完全相同（都是 internal/api/aiseed 的 formal）。
func loadAIStyle(r *http.Request, deps Deps, styleKey string) (aiStyle, error) {
	ensureSeededStyles(r, deps)

	if styleKey != "" {
		row, err := deps.Queries.GetAIStyleByKeyForAI(r.Context(), styleKey)
		if err == nil {
			return styleFromRow(row), nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return aiStyle{}, err
		}
	}

	row, err := deps.Queries.GetDefaultAIStyleForAI(r.Context())
	if err == nil {
		return styleFromRow(row), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return aiStyle{}, err
	}

	fallback := aiseed.Default()
	return aiStyle{Label: fallback.Label, SystemPrompt: fallback.SystemPrompt, Temperature: fallback.Temperature}, nil
}

// ensureSeededStyles 复刻 getAIStyle 开头的 `await ensureSeed()` 中「ai_styles 为空
// 时写入四条内置风格」那一半（运域 ai / 提示词域的 script 同一副本 aiseed.Styles）。
//
// 有意的收窄：seed.ts 的 ensureSeed 还会建表（schema.sql 负责）并补齐
// system_prompts——后者对本路径不可观测（getSystemPrompt 的硬编码兜底与种子文本
// 相同），跳过。
func ensureSeededStyles(r *http.Request, deps Deps) {
	count, err := deps.Queries.CountAIStylesForAI(r.Context())
	if err != nil {
		log.Printf("seed ai_styles: %v", err)
		return
	}
	if count != 0 {
		return
	}
	now := nowUnix()
	for _, style := range aiseed.Styles {
		isDefault := int64(0)
		if style.IsDefault {
			isDefault = 1
		}
		if err := deps.Queries.InsertAIStyleForAI(r.Context(), db.InsertAIStyleForAIParams{
			Key:          style.Key,
			Label:        style.Label,
			SystemPrompt: style.SystemPrompt,
			Temperature:  style.Temperature,
			IsDefault:    isDefault,
			CreatedAt:    now,
			UpdatedAt:    now,
		}); err != nil {
			log.Printf("seed ai_styles %s: %v", style.Key, err)
			return
		}
	}
}

// styleFromRow 复刻 `String(style.temperature)`：库里是 TEXT，TS 先 parseFloat 再
// 按 JS 的 Number#toString 写成字符串（"0.30" → "0.3"）。
func styleFromRow(row db.AiStyle) aiStyle {
	// parseFloat 失败在 JS 里是 NaN，String(NaN) 是 "NaN"（不是原始文本）。
	temperature := math.NaN()
	if parsed, ok := jsnum.ParseFloat(row.Temperature); ok {
		temperature = parsed
	}
	return aiStyle{Label: row.Label, SystemPrompt: row.SystemPrompt, Temperature: jsnum.FormatNumber(temperature)}
}

// timeFromUnix 把 Unix 秒折回 time.Time（会话标题的时间标签用）。
func timeFromUnix(seconds int64) time.Time { return time.Unix(seconds, 0) }

// builtinCheckPrompt / builtinGeneratePrompt 是 src/lib/ai.ts 的两份硬编码兜底。
const builtinCheckPrompt = `你是一个周报写作助手。用户正在写周报，请分析以下内容并给出改进建议。

内容：
{{content}}

{{#section}}当前区块：{{section}}{{/section}}

请从以下方面分析：
1. 是否有具体数据和细节支撑
2. 是否突出了成果和价值
3. 表达是否清晰简洁
4. 是否有更好的表达方式

请给出具体、简洁的建议（每条不超过20字）。
如果内容很好，返回空数组 []。`

const builtinGeneratePrompt = `你是周报终版生成助手。请严格依据原稿中的事实，按照模板要求输出 Markdown 周报。

规则：
- 只处理当前受众版本提供的原稿，不得引入其他版本的信息。
- 可以重组、合并、概括和补全表达，但不得虚构项目、数字、结果、时间或计划。
- 模板是格式规范，不要输出模板占位符、解释文字或代码围栏。
- 原稿没有事实支撑的章节请省略，或明确写出暂无内容。
- 只返回终版 Markdown 正文。`
