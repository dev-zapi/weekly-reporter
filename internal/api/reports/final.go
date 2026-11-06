package reports

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	reportlib "github.com/dev-zapi/weekly-reporter/internal/reports"
)

// 本文件复刻 PUT /api/reports/{id}/final：直接把用户手写的终版写进变体（不经过
// 生成会话）。ADR-0021 之后这仍是「直接编辑终版」的唯一入口。

// directFinalEditMessage 是接受过提案后再次直接编辑时写进会话基线的说明。
const directFinalEditMessage = "会话基线后的用户编辑。"

func saveFinalHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, ok := parseReportID(r)
		if !ok {
			failWithCode(w, http.StatusBadRequest, "Invalid report ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("PUT /api/reports/[id]/final error: %v", err)
			saveFinalFailure(w, err)
			return
		}

		object, isObject := body.(map[string]any)
		if !isObject {
			if body == nil {
				// `body.variant` 在 null 上是 TypeError，route.ts 的 catch 回 500。
				saveFinalFailure(w, errors.New("TypeError: Cannot read properties of null (reading 'variant')"))
				return
			}
			// 原始值上取属性得到 undefined，落进 INVALID_INPUT。
			failWithCode(w, http.StatusBadRequest, "Final content and audience variant are required", "INVALID_INPUT")
			return
		}

		variant := ""
		if value, present := object["variant"]; present {
			if text, isString := value.(string); isString && (text == "leadership" || text == "personal") {
				variant = text
			}
		}
		content, _ := object["content"].(string)
		if variant == "" || trimJS(content) == "" {
			failWithCode(w, http.StatusBadRequest, "Final content and audience variant are required", "INVALID_INPUT")
			return
		}
		if value, present := object["templateId"]; present {
			if _, isString := value.(string); !isString {
				failWithCode(w, http.StatusBadRequest, "templateId must be a string", "INVALID_INPUT")
				return
			}
		}
		if value, present := object["aiStyleKey"]; present {
			if _, isString := value.(string); !isString {
				failWithCode(w, http.StatusBadRequest, "aiStyleKey must be a string", "INVALID_INPUT")
				return
			}
		}

		// 模板与风格都只写「解析出来的快照」，因此先把两者解析出来（顺序照
		// route.ts：模板 → 风格 → 变体）。
		var templateSnapshot *reportlib.TemplateSelection
		if value, present := object["templateId"]; present {
			templateID, _ := value.(string)
			selection, err := reportlib.GetTemplateSelection(r.Context(), deps.Queries, templateID)
			if err != nil {
				log.Printf("PUT /api/reports/[id]/final error: %v", err)
				saveFinalFailure(w, err)
				return
			}
			if selection == nil {
				failWithCode(w, http.StatusBadRequest, "Unknown template: "+templateID, "VALIDATION_ERROR")
				return
			}
			templateSnapshot = selection
		}

		var aiStyleKey *string
		if value, present := object["aiStyleKey"]; present {
			styleKey, _ := value.(string)
			styleRow, err := deps.Queries.GetAIStyleByKeyForAI(r.Context(), styleKey)
			if errors.Is(err, sql.ErrNoRows) {
				failWithCode(w, http.StatusBadRequest, "Unknown AI style: "+styleKey, "VALIDATION_ERROR")
				return
			}
			if err != nil {
				log.Printf("PUT /api/reports/[id]/final error: %v", err)
				saveFinalFailure(w, err)
				return
			}
			key := styleRow.Key
			aiStyleKey = &key
		}

		existing, err := findVariant(r, deps, reportID, variant)
		if err != nil {
			log.Printf("PUT /api/reports/[id]/final error: %v", err)
			saveFinalFailure(w, err)
			return
		}

		trimmed := trimJS(content)
		now := nowUnix()

		// 个人版没有变体行时走「legacy 报告」分支：只改 reports.content。
		if existing == nil && variant == "personal" {
			_, err := deps.Queries.GetReportForReportRoutes(r.Context(), reportID)
			if errors.Is(err, sql.ErrNoRows) {
				failWithCode(w, http.StatusNotFound, "Report not found", "NOT_FOUND")
				return
			}
			if err != nil {
				log.Printf("PUT /api/reports/[id]/final error: %v", err)
				saveFinalFailure(w, err)
				return
			}
			updated, err := deps.Queries.UpdateReportContentForReportRoutes(r.Context(), db.UpdateReportContentForReportRoutesParams{
				Content:   trimmed,
				UpdatedAt: now,
				ID:        reportID,
			})
			if err != nil {
				log.Printf("PUT /api/reports/[id]/final error: %v", err)
				saveFinalFailure(w, err)
				return
			}
			respond.JSON(w, http.StatusOK, reportlib.ReportToJSON(updated))
			return
		}
		if existing == nil {
			failWithCode(w, http.StatusNotFound, "Report variant not found", "VARIANT_NOT_FOUND")
			return
		}

		// `body.sourceRevision != null`：只有显式给了非 null 值才校验版本。
		if value, present := object["sourceRevision"]; present && value != nil {
			revision, isInteger := jsInteger(value)
			if !isInteger || revision != float64(existing.SourceRevision) {
				failWithCode(w, http.StatusConflict, "The source draft has changed. Regenerate the final version from the latest draft.", "SOURCE_REVISION_CONFLICT")
				return
			}
		}

		params := db.UpdateReportVariantFinalForReportRoutesParams{
			FinalContent: &trimmed,
			UpdatedAt:    now,
			ID:           existing.ID,
		}
		if templateSnapshot != nil {
			id := templateSnapshot.ID
			name := templateSnapshot.Name
			text := templateSnapshot.Content
			params.TemplateID = &id
			params.TemplateName = &name
			params.TemplateContent = &text
		}
		params.AiStyle = aiStyleKey

		var result *reportlib.VariantJSON
		err = deps.Queries.InTx(r.Context(), func(tx *db.Queries) error {
			if err := tx.UpdateReportVariantFinalForReportRoutes(r.Context(), params); err != nil {
				return err
			}
			if variant == "personal" {
				if _, err := tx.UpdateReportContentForReportRoutes(r.Context(), db.UpdateReportContentForReportRoutesParams{
					Content:   trimmed,
					UpdatedAt: now,
					ID:        reportID,
				}); err != nil {
					return err
				}
			}
			if existing.AcceptedProposalID != nil {
				if err := recordDirectEditAfterAcceptedProposal(r, tx, reportID, existing, trimmed, variant, now); err != nil {
					return err
				}
			}

			variantRow, err := reportlib.GetReportVariant(r.Context(), tx, reportID, variant)
			if err != nil {
				return err
			}
			result = variantRow
			return nil
		})
		if err != nil {
			log.Printf("PUT /api/reports/[id]/final error: %v", err)
			saveFinalFailure(w, err)
			return
		}
		if result == nil {
			// `updated` 为 null 只可能发生在变体行被并发删除时；route.ts 会把 null
			// 直接写进响应体。
			respond.JSON(w, http.StatusOK, json.RawMessage("null"))
			return
		}
		respond.JSON(w, http.StatusOK, *result)
	}
}

// recordDirectEditAfterAcceptedProposal 复刻 route.ts 里「接受过提案后再次直接编辑」
// 的审计副作用：追加一条 application 文本 part，并把会话基线更新为新终版。
// 计划相关记录（ADR-0021 已废弃）一律不动。
func recordDirectEditAfterAcceptedProposal(
	r *http.Request,
	tx *db.Queries,
	reportID int64,
	existing *reportlib.VariantJSON,
	finalContent string,
	variant string,
	now int64,
) error {
	proposals, err := tx.ListGenerationProposalsForReportRoutes(r.Context(), db.ListGenerationProposalsForReportRoutesParams{
		IDFilter:      int64(1),
		ID:            *existing.AcceptedProposalID,
		SessionFilter: int64(0),
	})
	if err != nil {
		return err
	}
	if len(proposals) == 0 {
		return nil
	}
	session, err := tx.GetGenerationSessionForReportRoutes(r.Context(), db.GetGenerationSessionForReportRoutesParams{
		ID:       proposals[0].SessionID,
		ReportID: reportID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	sequence := int64(0)
	latest, err := tx.GetLatestGenerationMessageSequenceForReportRoutes(r.Context(), session.ID)
	if err == nil {
		sequence = latest
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	data := `{"event":"direct-final-edit","variant":"` + variant + `"}`
	if err := tx.InsertGenerationMessagePartForReportRoutes(r.Context(), db.InsertGenerationMessagePartForReportRoutesParams{
		SessionID: session.ID,
		TurnID:    nil,
		Sequence:  sequence + 1,
		Role:      "application",
		PartType:  "text",
		Content:   pointerTo(directFinalEditMessage),
		Data:      &data,
		CreatedAt: now,
	}); err != nil {
		return err
	}

	return tx.UpdateGenerationSessionBaselineForReportRoutes(r.Context(), db.UpdateGenerationSessionBaselineForReportRoutesParams{
		BaselineFinalContent: &finalContent,
		UpdatedAt:            now,
		ID:                   session.ID,
	})
}

// findVariant 是 `db.query.reportVariants.findFirst({where: and(reportId, variant)})`。
func findVariant(r *http.Request, deps Deps, reportID int64, variant string) (*reportlib.VariantJSON, error) {
	return reportlib.GetReportVariant(r.Context(), deps.Queries, reportID, variant)
}

// saveFinalFailure 复刻 route.ts 的 catch：500 + SAVE_FINAL_ERROR + details。
func saveFinalFailure(w http.ResponseWriter, err error) {
	respond.JSON(w, http.StatusInternalServerError, struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details string `json:"details"`
	}{Error: "Failed to save final version", Code: "SAVE_FINAL_ERROR", Details: "Error: " + err.Error()})
}

// jsInteger 复刻 `Number.isInteger(value)`（JSON 值域）。
func jsInteger(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok {
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
		return 0, false
	}
	return number, true
}

func pointerTo(value string) *string { return &value }
