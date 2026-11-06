// Package export 把导出路由（`POST /api/export`）挂到 chi 的 /api 子路由上。
// 行为逐条对照 src/app/api/export/route.ts：它只是回显「已选好的原文」，
// 不做模板渲染。
package export

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// Deps 是本域路由的依赖。导出不读库，保留空结构体以维持各域 Mount 形状一致。
type Deps struct{}

// Mount 把导出域注册到 /api 子路由上。
func Mount(r chi.Router, deps Deps) {
	r.Post("/export", exportHandler())
}

// exportHandler 复刻 POST /api/export：
//
//	content 必须是 trim 后非空的字符串（否则 400 INVALID_INPUT）；
//	variant 只认 'leadership'，其余一律 'personal'；
//	format 用 `??` 兜底：null/缺省 → markdown，其它值（含 ""、数字）原样回显。
func exportHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeAny(r)
		if err != nil {
			// route.ts 的 catch 也覆盖 request.json() 抛错。
			log.Printf("export: decode body: %v", err)
			fail(w)
			return
		}
		if body == nil {
			// `body.content` 对 null 抛 TypeError → catch → 500 EXPORT_ERROR。
			fail(w)
			return
		}

		object, _ := body.(map[string]any)
		content, ok := object["content"].(string)
		if !ok || jsstr.Trim(content) == "" {
			respond.Error(w, http.StatusBadRequest, "Export content is required", "INVALID_INPUT")
			return
		}

		variant := "personal"
		if v, ok := object["variant"].(string); ok && v == "leadership" {
			variant = "leadership"
		}

		// `body.format ?? 'markdown'` 只对 null/undefined 兜底；其它 JSON 值原样回显，
		// 所以用 RawMessage 保留请求里的字面量（数字、字符串、false 等）。
		format := json.RawMessage(`"markdown"`)
		if raw, present := object["format"]; present && raw != nil {
			encoded, err := json.Marshal(raw)
			if err != nil {
				log.Printf("export: encode format: %v", err)
				fail(w)
				return
			}
			format = encoded
		}

		respond.JSON(w, http.StatusOK, struct {
			Content string          `json:"content"`
			Variant string          `json:"variant"`
			Format  json.RawMessage `json:"format"`
		}{Content: content, Variant: variant, Format: format})
	}
}

func fail(w http.ResponseWriter) {
	respond.Error(w, http.StatusInternalServerError, "Export failed", "EXPORT_ERROR")
}

// decodeAny 复刻 `await request.json()`。
func decodeAny(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body any
	if err := dec.Decode(&body); err != nil {
		return nil, err
	}
	return body, nil
}
