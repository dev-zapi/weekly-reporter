package ai_test

import (
	"net/http"
	"strings"
	"testing"
)

// 本文件是 expand-section / unify-style 的 httptest 补充（票面：这两条没有
// 现有 vitest，按 route.ts 的行为补 happy path + `{error, code}` 错误形状 +
// 风格选择顺序）。polish-event 的同用例集在 polish_event_test.go。

type expandResponse struct {
	ExpandedItems []struct {
		Content any    `json:"content"`
		Source  string `json:"source"`
	} `json:"expandedItems"`
	AddedCount int    `json:"addedCount"`
	Message    string `json:"message"`
}

type unifyResponse struct {
	UnifiedContent string  `json:"unifiedContent"`
	ChangesCount   float64 `json:"changesCount"`
	Message        string  `json:"message"`
}

func TestExpandSectionRejectsMissingTitle(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/expand-section", `{"existingItems":[],"events":[]}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Section title is required" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestExpandSectionRejectsNonArrayExistingItems(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/expand-section", `{"sectionTitle":"成果","existingItems":"x","events":[]}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Existing items must be an array" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestExpandSectionRejectsNonArrayEvents(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/expand-section", `{"sectionTitle":"成果","existingItems":[],"events":{}}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Events must be an array" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
}

// 已有条目按 existing 回放，模型给的新条目按 generated 追加；addedCount 只数
// generated 那部分，message 里是同一个数字。
func TestExpandSectionAppendsGeneratedItems(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"newItems":["新条目一","新条目二"]}`)

	rec := h.do("/api/ai/expand-section",
		`{"sectionTitle":"成果","existingItems":["已有条目"],"events":["事件素材"]}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var resp expandResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if len(resp.ExpandedItems) != 3 {
		t.Fatalf("expandedItems = %+v", resp.ExpandedItems)
	}
	if resp.ExpandedItems[0].Content != "已有条目" || resp.ExpandedItems[0].Source != "existing" {
		t.Fatalf("first item = %+v", resp.ExpandedItems[0])
	}
	if resp.ExpandedItems[1].Content != "新条目一" || resp.ExpandedItems[1].Source != "generated" {
		t.Fatalf("second item = %+v", resp.ExpandedItems[1])
	}
	if resp.AddedCount != 2 {
		t.Fatalf("addedCount = %d, want 2", resp.AddedCount)
	}
	if resp.Message != "Added 2 new items" {
		t.Fatalf("message = %q", resp.Message)
	}
}

// 空数组也必须序列化成 []（Go 的 nil slice 会是 null）。
func TestExpandSectionReturnsEmptyArrayWhenNoItems(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"newItems":[]}`)

	rec := h.do("/api/ai/expand-section", `{"sectionTitle":"成果","existingItems":[],"events":[]}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if want := `"expandedItems":[]`; !strings.Contains(rec.Body.String(), want) {
		t.Fatalf("body = %s, want %s", rec.Body.String(), want)
	}
}

// existingItems / events 经 Array.join → String() 拼进提示词：指数区间的数字
// 必须是 JS 的 "1e-7" 形态（Go 的 strconv 'e' 会给 "1e-07"）。
func TestExpandSectionRendersNumbersLikeJavaScript(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"newItems":[]}`)

	rec := h.do("/api/ai/expand-section",
		`{"sectionTitle":"成果","existingItems":[1e-7],"events":[1.5e-8]}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	prompt, _ := h.mock.lastRequest().Body["input"].([]any)
	raw := h.mock.lastRequest().Raw
	if prompt == nil {
		t.Fatalf("request body missing input: %s", raw)
	}
	if !strings.Contains(raw, "1e-7") || !strings.Contains(raw, "1.5e-8") {
		t.Fatalf("prompt must carry JS number formatting: %s", raw)
	}
	if strings.Contains(raw, "1e-07") || strings.Contains(raw, "1.5e-08") {
		t.Fatalf("prompt carries Go number formatting: %s", raw)
	}
}

// expand-section 的选择顺序是 templateId → styleOverride（与 polish-event 相反）。
func TestExpandSectionPrefersTemplateOverStyleOverride(t *testing.T) {
	h := setupPolish(t)
	h.seedTemplate(1, "technical")
	h.mock.setText(`{"newItems":[]}`)

	rec := h.do("/api/ai/expand-section",
		`{"sectionTitle":"成果","existingItems":[],"events":[],"templateId":1,"styleOverride":"concise"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if temperature := h.mock.lastRequest().Body["temperature"]; temperature != 0.4 {
		t.Fatalf("temperature = %v, want 0.4 (technical, not concise)", temperature)
	}
}

// 模板 id 不存在时 getStyleFromTemplate 回退到默认风格。
func TestExpandSectionFallsBackToDefaultWhenTemplateMissing(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"newItems":[]}`)

	rec := h.do("/api/ai/expand-section",
		`{"sectionTitle":"成果","existingItems":[],"events":[],"templateId":99}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if temperature := h.mock.lastRequest().Body["temperature"]; temperature != 0.3 {
		t.Fatalf("temperature = %v, want 0.3 (default)", temperature)
	}
}

func TestExpandSectionHandlesProviderFailure(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"newItems":"not an array"}`)

	rec := h.do("/api/ai/expand-section", `{"sectionTitle":"成果","existingItems":[],"events":[]}`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Failed to expand section" || resp.Code != "EXPAND_ERROR" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestUnifyStyleRejectsMissingContent(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/unify-style", `{"reportContent":""}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Report content is required" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestUnifyStyleReturnsUnifiedContentAndChangeCount(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"unifiedContent":"统一后的内容","changesCount":3}`)

	rec := h.do("/api/ai/unify-style", `{"reportContent":"原文"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var resp unifyResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.UnifiedContent != "统一后的内容" {
		t.Fatalf("unifiedContent = %q", resp.UnifiedContent)
	}
	if resp.ChangesCount != 3 {
		t.Fatalf("changesCount = %v, want 3", resp.ChangesCount)
	}
	if resp.Message != "Style unified with 3 changes" {
		t.Fatalf("message = %q", resp.Message)
	}
}

func TestUnifyStyleUsesStyleOverrideWhenNoTemplate(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"unifiedContent":"x","changesCount":0}`)

	rec := h.do("/api/ai/unify-style", `{"reportContent":"原文","styleOverride":"concise"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if temperature := h.mock.lastRequest().Body["temperature"]; temperature != 0.2 {
		t.Fatalf("temperature = %v, want 0.2", temperature)
	}
}

func TestUnifyStyleHandlesProviderFailure(t *testing.T) {
	h := setupPolish(t)
	h.mock.setText(`{"unifiedContent":"x"}`) // 缺 changesCount

	rec := h.do("/api/ai/unify-style", `{"reportContent":"原文"}`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Failed to unify style" || resp.Code != "UNIFY_ERROR" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestAIStyleRoutesRequireAuth(t *testing.T) {
	h := setupPolish(t)

	cases := []struct{ path, body string }{
		{"/api/ai/expand-section", `{"sectionTitle":"成果","existingItems":[],"events":[]}`},
		{"/api/ai/polish-event", `{"eventContent":"Test content"}`},
		{"/api/ai/unify-style", `{"reportContent":"原文"}`},
	}
	for _, tc := range cases {
		rec := h.do(tc.path, tc.body, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401", tc.path, rec.Code)
		}
	}
}

// body 为 JSON null 时 `body.x` 抛 TypeError，落进 route.ts 的 catch（500）。
func TestAIStyleRoutesHandleNullBody(t *testing.T) {
	h := setupPolish(t)

	cases := []struct {
		path string
		code string
	}{
		{"/api/ai/expand-section", "EXPAND_ERROR"},
		{"/api/ai/polish-event", "POLISH_ERROR"},
		{"/api/ai/unify-style", "UNIFY_ERROR"},
	}
	for _, tc := range cases {
		rec := h.do(tc.path, "null", testPassword)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s status = %d, body %s", tc.path, rec.Code, rec.Body.String())
		}
		var resp errorResponse
		decodeJSONInto(t, rec.Body.Bytes(), &resp)
		if resp.Code != tc.code {
			t.Fatalf("%s code = %q, want %q", tc.path, resp.Code, tc.code)
		}
	}
}

// 非对象 body（数组/字符串/数字）在 JS 里解构不出字段，等价于空对象 → 400。
func TestAIStyleRoutesTreatScalarBodyAsEmptyObject(t *testing.T) {
	h := setupPolish(t)

	cases := []struct{ path, body string }{
		{"/api/ai/expand-section", `[1,2]`},
		{"/api/ai/polish-event", `"str"`},
		{"/api/ai/unify-style", `42`},
	}
	for _, tc := range cases {
		rec := h.do(tc.path, tc.body, testPassword)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", tc.path, rec.Code, rec.Body.String())
		}
		var resp errorResponse
		decodeJSONInto(t, rec.Body.Bytes(), &resp)
		if resp.Code != "INVALID_INPUT" {
			t.Fatalf("%s code = %q", tc.path, resp.Code)
		}
	}
}

// 布尔/数组/对象形态的 templateId / styleOverride 在 route.ts 里会让驱动抛错
// （200 之外的 500 分支），这里同样对齐。
func TestPolishEventRejectsUnbindableStyleValues(t *testing.T) {
	h := setupPolish(t)

	cases := []string{
		`{"eventContent":"x","templateId":true}`,
		`{"eventContent":"x","styleOverride":true}`,
		`{"eventContent":"x","styleOverride":["formal"]}`,
		`{"eventContent":"x","templateId":{"id":1}}`,
	}
	for _, body := range cases {
		rec := h.do("/api/ai/polish-event", body, testPassword)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("body %s: status = %d, want 500", body, rec.Code)
		}
		var resp errorResponse
		decodeJSONInto(t, rec.Body.Bytes(), &resp)
		if resp.Code != "POLISH_ERROR" {
			t.Fatalf("body %s: code = %q", body, resp.Code)
		}
	}
}
