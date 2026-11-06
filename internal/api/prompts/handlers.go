package prompts

import (
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// aiStyleJSON 是 ai_styles 行的响应形状（键名与 drizzle 属性名一致）：
// temperature 列是 TEXT，所以行里是字符串；isDefault 是 boolean mode。
type aiStyleJSON struct {
	ID             int64   `json:"id"`
	Key            string  `json:"key"`
	Label          string  `json:"label"`
	SystemPrompt   string  `json:"systemPrompt"`
	Temperature    string  `json:"temperature"`
	DetailLevel    *string `json:"detailLevel"`
	ResultOriented *string `json:"resultOriented"`
	IsDefault      bool    `json:"isDefault"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

func toAIStyleJSON(row db.AiStyle) aiStyleJSON {
	return aiStyleJSON{
		ID:             row.ID,
		Key:            row.Key,
		Label:          row.Label,
		SystemPrompt:   row.SystemPrompt,
		Temperature:    row.Temperature,
		DetailLevel:    row.DetailLevel,
		ResultOriented: row.ResultOriented,
		IsDefault:      row.IsDefault == 1,
		CreatedAt:      jsdate.ISOStringFromUnix(row.CreatedAt),
		UpdatedAt:      jsdate.ISOStringFromUnix(row.UpdatedAt),
	}
}

// aiStyleConfigJSON 是 rowToConfig 的结果：temperature 是 parseFloat 后的数字，
// detailLevel / resultOriented 为 null 时整个键被 JSON.stringify 丢掉。
type aiStyleConfigJSON struct {
	Label          string  `json:"label"`
	SystemPrompt   string  `json:"systemPrompt"`
	Temperature    any     `json:"temperature"`
	DetailLevel    *string `json:"detailLevel,omitempty"`
	ResultOriented *string `json:"resultOriented,omitempty"`
}

// aiStyleWithConfigJSON 复刻 `{ ...row, config: rowToConfig(row) }`。
type aiStyleWithConfigJSON struct {
	aiStyleJSON
	Config aiStyleConfigJSON `json:"config"`
}

func toAIStyleWithConfigJSON(row db.AiStyle) aiStyleWithConfigJSON {
	config := aiStyleConfigJSON{
		Label:          row.Label,
		SystemPrompt:   row.SystemPrompt,
		Temperature:    temperatureValue(row.Temperature),
		DetailLevel:    row.DetailLevel,
		ResultOriented: row.ResultOriented,
	}
	return aiStyleWithConfigJSON{aiStyleJSON: toAIStyleJSON(row), Config: config}
}

// temperatureValue 复刻 `parseFloat(row.temperature)` 的 JSON 输出：
// 非数值或 ±Infinity 在 JSON.stringify 里是 null。
func temperatureValue(text string) any {
	number, ok := ParseFloat(text)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	return number
}

// listStylesHandler 复刻 GET /api/prompts/styles：先 ensureSeed，再按
// createdAt 升序返回 {styles}。
func listStylesHandler(deps Deps, seeder *Seeder) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		seeder.Ensure(r.Context(), deps.Queries)

		rows, err := deps.Queries.ListAIStylesForPromptRoutes(r.Context())
		if err != nil {
			log.Printf("GET /api/prompts/styles error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to load styles", "FETCH_ERROR")
			return
		}

		styles := make([]aiStyleWithConfigJSON, 0, len(rows))
		for _, row := range rows {
			styles = append(styles, toAIStyleWithConfigJSON(row))
		}
		respond.JSON(w, http.StatusOK, struct {
			Styles []aiStyleWithConfigJSON `json:"styles"`
		}{Styles: styles})
	}
}

// createStyleHandler 复刻 POST /api/prompts/styles。
func createStyleHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("POST /api/prompts/styles error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create style", "CREATE_ERROR")
			return
		}

		input, ok := parseAIStyleBody(body)
		if !ok {
			respondValidation(w)
			return
		}

		isDefault := int64(0)
		if input.IsDefault.Present && input.IsDefault.Value {
			isDefault = 1
		}
		now := time.Now().Unix()
		row, err := deps.Queries.InsertAIStyleForPromptRoutes(r.Context(), db.InsertAIStyleForPromptRoutesParams{
			Key:            input.Key.Value,
			Label:          input.Label.Value,
			SystemPrompt:   input.SystemPrompt.Value,
			Temperature:    FormatNumber(input.Temperature),
			DetailLevel:    optionalPointer(input.DetailLevel),
			ResultOriented: optionalPointer(input.ResultOriented),
			IsDefault:      isDefault,
			CreatedAt:      now,
			UpdatedAt:      now,
		})
		if err != nil {
			log.Printf("POST /api/prompts/styles error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create style", "CREATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, struct {
			Style aiStyleJSON `json:"style"`
		}{Style: toAIStyleJSON(row)})
	}
}

// getStyleHandler 复刻 GET /api/prompts/styles/{id}。
func getStyleHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, err := getAIStyle(deps, r)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Style not found", "STYLE_NOT_FOUND")
			return
		}
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to load style", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Style aiStyleJSON `json:"style"`
		}{Style: toAIStyleJSON(row)})
	}
}

// updateStyleHandler 复刻 PUT /api/prompts/styles/{id}。
//
// 顺序照 route.ts：body 解析 → partial 校验 → updateAIStyle（不存在 → 404）。
// partial 里 temperature 带 default，缺失时按 0.3 写入（zod 4 实测行为）。
func updateStyleHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("PUT /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update style", "UPDATE_ERROR")
			return
		}

		input, ok := parseAIStylePartialBody(body)
		if !ok {
			respondValidation(w)
			return
		}

		id, found := parseStyleID(r)
		if !found {
			respond.Error(w, http.StatusNotFound, "Style not found", "STYLE_NOT_FOUND")
			return
		}

		existing, err := deps.Queries.GetAIStyleForPromptRoutes(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Style not found", "STYLE_NOT_FOUND")
			return
		}
		if err != nil {
			log.Printf("PUT /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update style", "UPDATE_ERROR")
			return
		}

		// updateAIStyle 的取值规则：`input.x !== undefined ? input.x : existing.x`
		// （key/label/systemPrompt/isDefault 用 `??`，两者在 JSON 输入下等价）。
		params := db.UpdateAIStyleForPromptRoutesParams{
			Key:            optionalPointer(input.Key),
			Label:          optionalPointer(input.Label),
			SystemPrompt:   optionalPointer(input.SystemPrompt),
			Temperature:    pointerTo(FormatNumber(input.Temperature)),
			DetailLevel:    optionalPointer(input.DetailLevel),
			ResultOriented: optionalPointer(input.ResultOriented),
			IsDefault:      optionalIntPointer(input.IsDefault),
			UpdatedAt:      time.Now().Unix(),
			ID:             existing.ID,
		}
		row, err := deps.Queries.UpdateAIStyleForPromptRoutes(r.Context(), params)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Style not found", "STYLE_NOT_FOUND")
			return
		}
		if err != nil {
			log.Printf("PUT /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update style", "UPDATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Style aiStyleJSON `json:"style"`
		}{Style: toAIStyleJSON(row)})
	}
}

// deleteStyleHandler 复刻 DELETE /api/prompts/styles/{id}。
//
// 注意 route.ts 的状态码推导：`result.error === 'Style not found' ? 404 : 400`，
// 而 deleteAIStyle 返回的是中文错误串（风格不存在 / 无法删除最后一个风格 /
// 默认风格不能删除…），所以业务失败恒为 400。这是现有行为，照抄。
func deleteStyleHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, found := parseStyleID(r)
		if !found {
			respondDeleteFailure(w, "风格不存在")
			return
		}

		existing, err := deps.Queries.GetAIStyleForPromptRoutes(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respondDeleteFailure(w, "风格不存在")
			return
		}
		if err != nil {
			log.Printf("DELETE /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete style", "DELETE_ERROR")
			return
		}

		count, err := deps.Queries.CountAIStylesForPromptRoutes(r.Context())
		if err != nil {
			log.Printf("DELETE /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete style", "DELETE_ERROR")
			return
		}
		if count <= 1 {
			respondDeleteFailure(w, "无法删除最后一个风格")
			return
		}
		if existing.IsDefault != 0 {
			respondDeleteFailure(w, "默认风格不能删除，请先将其他风格设为默认")
			return
		}

		// 清除引用该风格的报告与模板（ADR-0005 的删除语义）。
		if err := deps.Queries.ClearReportStyleOverrideForPromptRoutes(r.Context(), &existing.Key); err != nil {
			log.Printf("DELETE /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete style", "DELETE_ERROR")
			return
		}
		if err := deps.Queries.ResetTemplateStyleForPromptRoutes(r.Context(), db.ResetTemplateStyleForPromptRoutesParams{
			UpdatedAt: time.Now().Unix(),
			AiStyle:   existing.Key,
		}); err != nil {
			log.Printf("DELETE /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete style", "DELETE_ERROR")
			return
		}
		if err := deps.Queries.DeleteAIStyleForPromptRoutes(r.Context(), existing.ID); err != nil {
			log.Printf("DELETE /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete style", "DELETE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Success bool   `json:"success"`
			Message string `json:"message"`
		}{Success: true, Message: "Style deleted"})
	}
}

// setDefaultStyleHandler 复刻 PATCH /api/prompts/styles/{id}（设为默认风格）。
func setDefaultStyleHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, found := parseStyleID(r)
		if !found {
			respond.Error(w, http.StatusNotFound, "Style not found", "STYLE_NOT_FOUND")
			return
		}

		existing, err := deps.Queries.GetAIStyleForPromptRoutes(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Style not found", "STYLE_NOT_FOUND")
			return
		}
		if err != nil {
			log.Printf("PATCH /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to set default style", "UPDATE_ERROR")
			return
		}

		now := time.Now().Unix()
		if err := deps.Queries.ClearAIStyleDefaultsForPromptRoutes(r.Context(), now); err != nil {
			log.Printf("PATCH /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to set default style", "UPDATE_ERROR")
			return
		}
		if err := deps.Queries.SetAIStyleDefaultForPromptRoutes(r.Context(), db.SetAIStyleDefaultForPromptRoutesParams{
			UpdatedAt: now,
			ID:        existing.ID,
		}); err != nil {
			log.Printf("PATCH /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to set default style", "UPDATE_ERROR")
			return
		}

		row, err := deps.Queries.GetAIStyleForPromptRoutes(r.Context(), existing.ID)
		if err != nil {
			log.Printf("PATCH /api/prompts/styles/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to set default style", "UPDATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Style   aiStyleJSON `json:"style"`
			Message string      `json:"message"`
		}{Style: toAIStyleJSON(row), Message: "Style set as default"})
	}
}

// systemPromptJSON 是 system_prompts 行的响应形状。
type systemPromptJSON struct {
	ID         int64  `json:"id"`
	Key        string `json:"key"`
	Label      string `json:"label"`
	PromptText string `json:"promptText"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

func toSystemPromptJSON(row db.SystemPrompt) systemPromptJSON {
	return systemPromptJSON{
		ID:         row.ID,
		Key:        row.Key,
		Label:      row.Label,
		PromptText: row.PromptText,
		CreatedAt:  jsdate.ISOStringFromUnix(row.CreatedAt),
		UpdatedAt:  jsdate.ISOStringFromUnix(row.UpdatedAt),
	}
}

// listSystemPromptsHandler 复刻 GET /api/prompts/system：先 ensureSeed，
// 再按 key 升序返回 {prompts}。
func listSystemPromptsHandler(deps Deps, seeder *Seeder) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		seeder.Ensure(r.Context(), deps.Queries)

		rows, err := deps.Queries.ListSystemPromptsForPromptRoutes(r.Context())
		if err != nil {
			log.Printf("GET /api/prompts/system error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to load system prompts", "FETCH_ERROR")
			return
		}

		prompts := make([]systemPromptJSON, 0, len(rows))
		for _, row := range rows {
			prompts = append(prompts, toSystemPromptJSON(row))
		}
		respond.JSON(w, http.StatusOK, struct {
			Prompts []systemPromptJSON `json:"prompts"`
		}{Prompts: prompts})
	}
}

// updateSystemPromptHandler 复刻 PUT /api/prompts/system。
//
// 顺序：systemPromptSchema 校验 → key 白名单 → 存在性 → 更新。key 取自原始
// body（不是校验输出）。
func updateSystemPromptHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("PUT /api/prompts/system error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update system prompt", "UPDATE_ERROR")
			return
		}

		promptText, ok := parseSystemPromptBody(body)
		if !ok {
			respondValidation(w)
			return
		}

		object, _ := body.(map[string]any)
		key, keyOK := object["key"].(string)
		if !keyOK || (key != "check" && key != "generate") {
			respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{
				Error: "Invalid prompt key",
				Code:  "VALIDATION_ERROR",
			})
			return
		}

		if _, err := deps.Queries.GetSystemPromptForPromptRoutes(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "System prompt not found", "NOT_FOUND")
			return
		} else if err != nil {
			log.Printf("PUT /api/prompts/system error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update system prompt", "UPDATE_ERROR")
			return
		}

		row, err := deps.Queries.UpdateSystemPromptForPromptRoutes(r.Context(), db.UpdateSystemPromptForPromptRoutesParams{
			PromptText: promptText,
			UpdatedAt:  time.Now().Unix(),
			Key:        key,
		})
		if err != nil {
			log.Printf("PUT /api/prompts/system error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update system prompt", "UPDATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Prompt systemPromptJSON `json:"prompt"`
		}{Prompt: toSystemPromptJSON(row)})
	}
}

// getAIStyle 按路径参数取风格行；parseInt 失败（NaN）等价于「查不到」。
func getAIStyle(deps Deps, r *http.Request) (db.AiStyle, error) {
	id, ok := parseStyleID(r)
	if !ok {
		return db.AiStyle{}, sql.ErrNoRows
	}
	return deps.Queries.GetAIStyleForPromptRoutes(r.Context(), id)
}

// parseStyleID 复刻 route.ts 里的 `parseInt(id)`（无 radix）。
func parseStyleID(r *http.Request) (int64, bool) {
	return jsparse.ParseInt(chi.URLParam(r, "id"))
}

// optionalPointer 把 optionalString 折成 sqlc 的 *string。
func optionalPointer(value optionalString) *string {
	if !value.Present {
		return nil
	}
	return &value.Value
}

func optionalIntPointer(value optionalBool) *int64 {
	if !value.Present {
		return nil
	}
	var encoded int64
	if value.Value {
		encoded = 1
	}
	return &encoded
}

func pointerTo(value string) *string { return &value }

// respondValidation 复刻 zod 失败的 400 形状（prompts 路由不带 details）。
func respondValidation(w http.ResponseWriter) {
	respond.Error(w, http.StatusBadRequest, "Validation failed", "VALIDATION_ERROR")
}

// respondDeleteFailure 写 deleteAIStyle 的业务失败：route.ts 恒用 400。
func respondDeleteFailure(w http.ResponseWriter, message string) {
	respond.JSON(w, http.StatusBadRequest, respond.ErrorBody{
		Error: message,
		Code:  "DELETE_ERROR",
	})
}
