package templates

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/officialtemplates"
)

// templateJSON 是 templates 行的响应形状：键名与 drizzle 的属性名一致
// （camelCase），时间列是 Date 经 JSON.stringify 得到的 ISO 字符串。
type templateJSON struct {
	ID               int64   `json:"id"`
	Name             string  `json:"name"`
	Content          string  `json:"content"`
	Description      *string `json:"description"`
	Tags             *string `json:"tags"`
	SourceTemplateID *string `json:"sourceTemplateId"`
	AiStyle          string  `json:"aiStyle"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

func toTemplateJSON(row db.Template) templateJSON {
	return templateJSON{
		ID:               row.ID,
		Name:             row.Name,
		Content:          row.Content,
		Description:      row.Description,
		Tags:             row.Tags,
		SourceTemplateID: row.SourceTemplateID,
		AiStyle:          row.AiStyle,
		CreatedAt:        jsdate.ISOStringFromUnix(row.CreatedAt),
		UpdatedAt:        jsdate.ISOStringFromUnix(row.UpdatedAt),
	}
}

// listHandler 复刻 GET /api/templates：{official, user}。
//
// 用户模板没有 ORDER BY（route.ts 的 db.select() 不带 orderBy），按 SQLite 的
// rowid 顺序返回；空表回 [] 而不是 null。
func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := deps.Queries.ListTemplatesForTemplateRoutes(r.Context())
		if err != nil {
			log.Printf("GET /api/templates error: %v", err)
			respondJSONDetails(w, http.StatusInternalServerError, "Failed to load templates", "FETCH_ERROR", err)
			return
		}

		user := make([]templateJSON, 0, len(rows))
		for _, row := range rows {
			user = append(user, toTemplateJSON(row))
		}
		respond.JSON(w, http.StatusOK, struct {
			Official []officialtemplates.OfficialTemplate `json:"official"`
			User     []templateJSON                       `json:"user"`
		}{Official: officialtemplates.All, User: user})
	}
}

// createHandler 复刻 POST /api/templates。
//
// 未提供的 description/tags 落 NULL；未提供的 aiStyle 走列默认值 'formal'
// （drizzle 对带默认值的列在 insert 时显式填默认值，见 probe）。
func createHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeBody(r)
		if err != nil {
			log.Printf("POST /api/templates error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create template", "CREATE_ERROR")
			return
		}

		input, ok := parseTemplateBody(body)
		if !ok {
			respondValidation(w)
			return
		}

		now := time.Now().Unix()
		aiStyle := "formal"
		if input.AiStyle.Present {
			aiStyle = input.AiStyle.Value
		}
		row, err := deps.Queries.InsertTemplateForTemplateRoutes(r.Context(), db.InsertTemplateForTemplateRoutesParams{
			Name:        input.Name,
			Content:     input.Content,
			Description: optionalPointer(input.Description),
			Tags:        optionalPointer(input.Tags),
			AiStyle:     aiStyle,
			CreatedAt:   now,
			UpdatedAt:   now,
		})
		if err != nil {
			log.Printf("POST /api/templates error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to create template", "CREATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, struct {
			Template templateJSON `json:"template"`
		}{Template: toTemplateJSON(row)})
	}
}

// getHandler 复刻 GET /api/templates/{id}。
//
// parseInt 失败（NaN）在 drizzle 里绑定成「永不匹配」的参数，查询照常执行并
// 返回空集，所以最终是 404 而不是 400。
func getHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, err := getTemplate(deps, r)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Template not found", "TEMPLATE_NOT_FOUND")
			return
		}
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to load template", "FETCH_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Template templateJSON `json:"template"`
		}{Template: toTemplateJSON(row)})
	}
}

// updateHandler 复刻 PUT /api/templates/{id}。
//
// 顺序照 route.ts：先解析 body（失败 → 500 UPDATE_ERROR），再查行（不存在 →
// 404），最后判断 style-only。body 为 JSON null 时 `Object.keys(null)` 抛
// TypeError → 500 UPDATE_ERROR。
func updateHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeBody(r)
		if err != nil {
			log.Printf("PUT /api/templates/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update template", "UPDATE_ERROR")
			return
		}

		existing, err := getTemplate(deps, r)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Template not found", "TEMPLATE_NOT_FOUND")
			return
		}
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to update template", "UPDATE_ERROR")
			return
		}

		if body == nil {
			// Object.keys(null) 在 JS 里抛 TypeError。
			log.Printf("PUT /api/templates/[id] error: request body is null")
			respond.Error(w, http.StatusInternalServerError, "Failed to update template", "UPDATE_ERROR")
			return
		}

		now := time.Now().Unix()

		// 两条分支写回同一组参数，只是取值规则不同：style-only 时 name/content
		// 原样写回（与「不写」不可观测地区分），完整更新时取校验结果。drizzle 会
		// 省略值为 undefined 的键，所以 body 是 {} 时等价于只更新 updated_at。
		var row db.Template
		if isStyleOnlyUpdate(body) {
			aiStyle, ok := parseStyleOnlyBody(body)
			if !ok {
				respondValidation(w)
				return
			}
			styleValue := existing.AiStyle
			if aiStyle.Present {
				styleValue = aiStyle.Value
			}
			row, err = deps.Queries.UpdateTemplateForTemplateRoutes(r.Context(), db.UpdateTemplateForTemplateRoutesParams{
				Name:        existing.Name,
				Content:     existing.Content,
				Description: existing.Description,
				Tags:        existing.Tags,
				AiStyle:     styleValue,
				UpdatedAt:   now,
				ID:          existing.ID,
			})
		} else {
			input, ok := parseTemplateBody(body)
			if !ok {
				respondValidation(w)
				return
			}
			aiStyle := existing.AiStyle
			if input.AiStyle.Present {
				aiStyle = input.AiStyle.Value
			}
			row, err = deps.Queries.UpdateTemplateForTemplateRoutes(r.Context(), db.UpdateTemplateForTemplateRoutesParams{
				Name:        input.Name,
				Content:     input.Content,
				Description: optionalPointer(input.Description),
				Tags:        optionalPointer(input.Tags),
				AiStyle:     aiStyle,
				UpdatedAt:   now,
				ID:          existing.ID,
			})
		}
		if err != nil {
			log.Printf("PUT /api/templates/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to update template", "UPDATE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Template templateJSON `json:"template"`
		}{Template: toTemplateJSON(row)})
	}
}

// deleteHandler 复刻 DELETE /api/templates/{id}。
func deleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		existing, err := getTemplate(deps, r)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Template not found", "TEMPLATE_NOT_FOUND")
			return
		}
		if err != nil {
			respond.Error(w, http.StatusInternalServerError, "Failed to delete template", "DELETE_ERROR")
			return
		}

		if err := deps.Queries.DeleteTemplateForTemplateRoutes(r.Context(), existing.ID); err != nil {
			log.Printf("DELETE /api/templates/[id] error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete template", "DELETE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Success bool   `json:"success"`
			Message string `json:"message"`
		}{Success: true, Message: "Template deleted"})
	}
}

// cloneHandler 复刻 POST /api/templates/clone。
//
// sourceId 前缀决定来源：official-* 查静态种子，user-* 查库；两者都没有命中
// 时是 400 TEMPLATE_NOT_FOUND。新模板的 description/tags 恒为 undefined
// （克隆只复制名称、正文与风格）。
func cloneHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeBody(r)
		if err != nil {
			log.Printf("POST /api/templates/clone error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to clone template", "CLONE_ERROR")
			return
		}

		input, ok := parseCloneBody(body)
		if !ok {
			respondValidation(w)
			return
		}

		name, content, aiStyle, found, err := resolveCloneSource(deps, r, input.SourceID)
		if err != nil {
			log.Printf("POST /api/templates/clone error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to clone template", "CLONE_ERROR")
			return
		}
		if !found {
			respond.Error(w, http.StatusBadRequest, "Source template not found", "TEMPLATE_NOT_FOUND")
			return
		}

		// `validated.name || sourceTemplate.name`：空串是 falsy，回落来源值。
		if !input.Name.Present || input.Name.Value == "" {
			input.Name = optionalString{Value: name, Present: true}
		}
		if !input.Content.Present || input.Content.Value == "" {
			input.Content = optionalString{Value: content, Present: true}
		}

		now := time.Now().Unix()
		row, err := deps.Queries.InsertTemplateForTemplateRoutes(r.Context(), db.InsertTemplateForTemplateRoutesParams{
			Name:             input.Name.Value,
			Content:          input.Content.Value,
			Description:      nil,
			Tags:             nil,
			SourceTemplateID: &input.SourceID,
			AiStyle:          aiStyle,
			CreatedAt:        now,
			UpdatedAt:        now,
		})
		if err != nil {
			log.Printf("POST /api/templates/clone error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to clone template", "CLONE_ERROR")
			return
		}

		respond.JSON(w, http.StatusCreated, struct {
			Template templateJSON `json:"template"`
			Message  string       `json:"message"`
		}{Template: toTemplateJSON(row), Message: "Template cloned successfully"})
	}
}

// resolveCloneSource 复刻 clone 路由的来源解析：返回名称、正文、AI 风格。
// 官方模板的 aiStyle 都在种子里显式给出；用户模板的 ai_style 列 NOT NULL。
// aiStyle 为空表示需要走列默认值 'formal'；err 非 nil 表示 route.ts 的 catch
// 分支（500 CLONE_ERROR）。
func resolveCloneSource(deps Deps, r *http.Request, sourceID string) (name, content, aiStyle string, found bool, err error) {
	if strings.HasPrefix(sourceID, "official-") {
		template, ok := officialtemplates.ByID(sourceID)
		if !ok {
			return "", "", "", false, nil
		}
		return template.Name, template.Content, template.AiStyle, true, nil
	}
	if strings.HasPrefix(sourceID, "user-") {
		// JS 的 String.replace 只替换第一处；前缀已在 index 0，等价于去掉前缀。
		id, ok := jsparse.ParseInt(strings.Replace(sourceID, "user-", "", 1))
		if !ok {
			return "", "", "", false, nil
		}
		row, err := deps.Queries.GetTemplateForTemplateRoutes(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", "", false, nil
		}
		if err != nil {
			return "", "", "", false, err
		}
		return row.Name, row.Content, row.AiStyle, true, nil
	}
	return "", "", "", false, nil
}

// renderHandler 复刻 GET /api/templates/{id}/render：确定性渲染器已移除，
// 恒回 410 + TEMPLATE_RENDER_REMOVED（route.test.ts 的同用例集转到 Go）。
func renderHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond.JSON(w, http.StatusGone, respond.ErrorBody{
			Error: "周报模板不再由系统直接渲染，请使用终版生成接口",
			Code:  "TEMPLATE_RENDER_REMOVED",
		})
	}
}

// getTemplate 按路径参数取模板行；parseInt 失败（NaN）等价于「查不到」。
func getTemplate(deps Deps, r *http.Request) (db.Template, error) {
	id, ok := jsparse.ParseInt(chi.URLParam(r, "id"))
	if !ok {
		return db.Template{}, sql.ErrNoRows
	}
	return deps.Queries.GetTemplateForTemplateRoutes(r.Context(), id)
}

// optionalPointer 把 optionalString 折成 sqlc 的 *string（Present=false → NULL）。
func optionalPointer(value optionalString) *string {
	if !value.Present {
		return nil
	}
	return &value.Value
}

// respondValidation 复刻 zod 失败的 400 形状（templates 路由不带 details）。
func respondValidation(w http.ResponseWriter) {
	respond.Error(w, http.StatusBadRequest, "Validation failed", "VALIDATION_ERROR")
}

// respondJSONDetails 写 GET 列表的 500 形状：{error, code, details}，
// details 是 String(error)（诊断字段，文本不构成契约）。
func respondJSONDetails(w http.ResponseWriter, status int, message, code string, err error) {
	respond.JSON(w, status, struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details string `json:"details"`
	}{Error: message, Code: code, Details: "Error: " + err.Error()})
}
