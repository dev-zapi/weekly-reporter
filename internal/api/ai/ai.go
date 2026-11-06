// Package ai 把三条 AI 一次性生成路由挂到 chi 的 /api 子路由上：
// `/api/ai/expand-section`、`/api/ai/polish-event`、`/api/ai/unify-style`。
//
// 行为逐条对照 src/app/api/ai/*/route.ts，模型调用走 internal/aiclient 的
// one-shot 路径（generateObject + zod 的 Go 对应物，见 ADR-0027 §7）。
package ai

import (
	"errors"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsnum"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// Deps 是本域路由的数据依赖。
type Deps struct {
	Queries *db.Queries
}

// Mount 把 AI 域注册到 /api 子路由上。
//
// 路由表与 src/app/api/ai 目录一一对应：
//
//	POST /ai/expand-section
//	POST /ai/polish-event
//	POST /ai/unify-style
func Mount(r chi.Router, deps Deps) {
	r.Post("/ai/expand-section", expandSectionHandler(deps))
	r.Post("/ai/polish-event", polishEventHandler(deps))
	r.Post("/ai/unify-style", unifyStyleHandler(deps))
}

// routeError 是三条路由 catch 分支需要的固定文案，取自各自的 route.ts。
// nullField 只用于把 body 为 null 时 `body.x` 的 TypeError 文本凑成诊断细节。
type routeError struct {
	logMessage string // console.error 的前缀
	message    string // {error}
	code       string // {code}
	nullField  string // body 为 null 时首个属性访问的字段名
}

var (
	expandSectionError = routeError{
		"POST /api/ai/expand-section", "Failed to expand section", "EXPAND_ERROR", "sectionTitle",
	}
	polishEventError = routeError{
		"POST /api/ai/polish-event", "Failed to polish event", "POLISH_ERROR", "eventContent",
	}
	unifyStyleError = routeError{
		"POST /api/ai/unify-style", "Failed to unify style", "UNIFY_ERROR", "reportContent",
	}
)

// expandSectionHandler 复刻 POST /api/ai/expand-section。
func expandSectionHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r, expandSectionError)
		if !ok {
			return
		}

		// `!body.sectionTitle || typeof body.sectionTitle !== 'string'`
		sectionTitle, _ := body["sectionTitle"].(string)
		if sectionTitle == "" {
			respond.Error(w, http.StatusBadRequest, "Section title is required", "INVALID_INPUT")
			return
		}
		existingItems, ok := body["existingItems"].([]any)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Existing items must be an array", "INVALID_INPUT")
			return
		}
		events, ok := body["events"].([]any)
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Events must be an array", "INVALID_INPUT")
			return
		}

		// 顺序：templateId → styleOverride → 默认。
		style, err := deps.resolveStyle(r.Context(), body, false)
		if err != nil {
			fail(w, expandSectionError, err)
			return
		}

		expandedItems, err := deps.expandSection(
			r.Context(), sectionTitle, existingItems, events, style.SystemPrompt, style.Temperature,
		)
		if err != nil {
			fail(w, expandSectionError, err)
			return
		}

		addedCount := 0
		for _, item := range expandedItems {
			if item.Source == "generated" {
				addedCount++
			}
		}

		respond.JSON(w, http.StatusOK, struct {
			ExpandedItems []expandedItem `json:"expandedItems"`
			AddedCount    int            `json:"addedCount"`
			Message       string         `json:"message"`
		}{
			ExpandedItems: expandedItems,
			AddedCount:    addedCount,
			Message:       "Added " + jsnum.FormatNumber(float64(addedCount)) + " new items",
		})
	}
}

// polishEventHandler 复刻 POST /api/ai/polish-event。
func polishEventHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r, polishEventError)
		if !ok {
			return
		}

		eventContent, _ := body["eventContent"].(string)
		if eventContent == "" {
			respond.Error(w, http.StatusBadRequest, "Event content is required", "INVALID_INPUT")
			return
		}

		// 顺序：styleOverride → templateId → 默认（与另两条相反）。
		style, err := deps.resolveStyle(r.Context(), body, true)
		if err != nil {
			fail(w, polishEventError, err)
			return
		}

		polishedContent, err := deps.polishEvent(r.Context(), eventContent, style.SystemPrompt, style.Temperature)
		if err != nil {
			fail(w, polishEventError, err)
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			PolishedContent string `json:"polishedContent"`
			Style           string `json:"style"`
			Message         string `json:"message"`
		}{
			PolishedContent: polishedContent,
			Style:           style.Label,
			Message:         "Event polished successfully",
		})
	}
}

// unifyStyleHandler 复刻 POST /api/ai/unify-style。
func unifyStyleHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r, unifyStyleError)
		if !ok {
			return
		}

		reportContent, _ := body["reportContent"].(string)
		if reportContent == "" {
			respond.Error(w, http.StatusBadRequest, "Report content is required", "INVALID_INPUT")
			return
		}

		// 顺序：templateId → styleOverride → 默认。
		style, err := deps.resolveStyle(r.Context(), body, false)
		if err != nil {
			fail(w, unifyStyleError, err)
			return
		}

		unifiedContent, changesCount, err := deps.unifyStyle(
			r.Context(), reportContent, style.SystemPrompt, style.Temperature,
		)
		if err != nil {
			fail(w, unifyStyleError, err)
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			UnifiedContent string `json:"unifiedContent"`
			// changesCount 是 `z.number()`：非整数也要原样回显（TS 侧不做取整）。
			ChangesCount float64 `json:"changesCount"`
			Message      string  `json:"message"`
		}{
			UnifiedContent: unifiedContent,
			ChangesCount:   changesCount,
			Message:        "Style unified with " + jsnum.FormatNumber(changesCount) + " changes",
		})
	}
}

// readBody 复刻 `await request.json()` 加三条路由共有的前置判断。
//
// 解析失败（JSON.parse 抛错）与 body 为 null（`body.x` 抛 TypeError）都落进
// route.ts 的 catch：500 + 该路由的 error/code，details 是 String(error)。
func readBody(w http.ResponseWriter, r *http.Request, route routeError) (map[string]any, bool) {
	body, err := jsjson.DecodeBody(r)
	if err != nil {
		fail(w, route, err)
		return nil, false
	}
	if body == nil {
		fail(w, route, errors.New("TypeError: Cannot read properties of null (reading '"+route.nullField+"')"))
		return nil, false
	}
	return objectBody(body), true
}

// fail 写 route.ts 的 catch 分支：AIConfigError → 400 + AI_NOT_CONFIGURED，
// 其余一律 500 + 该路由的 error/code/details。
func fail(w http.ResponseWriter, route routeError, err error) {
	log.Printf("%s error: %v", route.logMessage, err)

	var configErr *AIConfigError
	if errors.As(err, &configErr) {
		respond.Error(w, http.StatusBadRequest, configErr.Message, "AI_NOT_CONFIGURED")
		return
	}

	respond.JSON(w, http.StatusInternalServerError, struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details string `json:"details"`
	}{Error: route.message, Code: route.code, Details: err.Error()})
}
