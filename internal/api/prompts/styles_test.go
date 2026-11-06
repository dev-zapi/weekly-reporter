package prompts_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 /api/prompts/styles 的 httptest 用例集，行为以
// src/app/api/prompts/styles 下的 route.ts 与 src/lib/ai/styles.ts 为唯一事实源。

type styleConfig struct {
	Label          string   `json:"label"`
	SystemPrompt   string   `json:"systemPrompt"`
	Temperature    *float64 `json:"temperature"`
	DetailLevel    *string  `json:"detailLevel"`
	ResultOriented *string  `json:"resultOriented"`
}

type styleJSON struct {
	ID             int64        `json:"id"`
	Key            string       `json:"key"`
	Label          string       `json:"label"`
	SystemPrompt   string       `json:"systemPrompt"`
	Temperature    string       `json:"temperature"`
	DetailLevel    *string      `json:"detailLevel"`
	ResultOriented *string      `json:"resultOriented"`
	IsDefault      bool         `json:"isDefault"`
	CreatedAt      string       `json:"createdAt"`
	UpdatedAt      string       `json:"updatedAt"`
	Config         *styleConfig `json:"config"`
}

type stylesResponse struct {
	Styles []styleJSON `json:"styles"`
}

type styleResponse struct {
	Style styleJSON `json:"style"`
}

type errorResponse struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	Details string `json:"details"`
}

func decode[T any](t *testing.T, body []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return value
}

func TestStylesGetSeedsBuiltins(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodGet, "/api/prompts/styles", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[stylesResponse](t, rec.Body.Bytes())
	if len(resp.Styles) != 4 {
		t.Fatalf("styles = %d, want 4 seeded", len(resp.Styles))
	}

	// 顺序：created_at 相同 → SQLite 按 rowid 返回，即 seed 的插入顺序。
	wantKeys := []string{"formal", "technical", "concise", "detailed"}
	for i, want := range wantKeys {
		if resp.Styles[i].Key != want {
			t.Fatalf("styles[%d].key = %q, want %q", i, resp.Styles[i].Key, want)
		}
	}
	formal := resp.Styles[0]
	if !formal.IsDefault {
		t.Fatalf("formal.isDefault = false, want true")
	}
	if formal.Temperature != "0.3" {
		t.Fatalf("formal.temperature = %q, want the TEXT column value", formal.Temperature)
	}
	if formal.Config == nil || formal.Config.Temperature == nil || *formal.Config.Temperature != 0.3 {
		t.Fatalf("formal.config.temperature = %+v", formal.Config)
	}
	// NULL 的 detailLevel 在 config 里整个键被 JSON.stringify 丢掉。
	if formal.Config.DetailLevel != nil || formal.Config.ResultOriented != nil {
		t.Fatalf("formal.config nullable keys = %+v", formal.Config)
	}
	if resp.Styles[1].Key == "technical" && resp.Styles[1].Temperature != "0.4" {
		t.Fatalf("technical.temperature = %q", resp.Styles[1].Temperature)
	}
}

// ensureSeed 是幂等的：第二次 GET 不会重复插入（也不会清掉用户数据）。
func TestStylesGetSeedsOnlyOnce(t *testing.T) {
	h := newHarness(t)

	for i := 0; i < 2; i++ {
		rec := h.authed(http.MethodGet, "/api/prompts/styles", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if got := len(decode[stylesResponse](t, rec.Body.Bytes()).Styles); got != 4 {
			t.Fatalf("run %d: styles = %d, want 4", i, got)
		}
	}
}

// 表里已有数据时 ensureSeed 不再灌入内置风格（count>0）。
func TestStylesGetDoesNotSeedWhenNotEmpty(t *testing.T) {
	h := newHarness(t)
	h.seedStyle("custom", "自定义", "prompt", "0.5", nil, nil, 0, 1_700_000_000)

	rec := h.authed(http.MethodGet, "/api/prompts/styles", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decode[stylesResponse](t, rec.Body.Bytes())
	if len(resp.Styles) != 1 || resp.Styles[0].Key != "custom" {
		t.Fatalf("styles = %+v, want only the seeded custom style", resp.Styles)
	}
	if resp.Styles[0].Config == nil || resp.Styles[0].Config.Temperature == nil || *resp.Styles[0].Config.Temperature != 0.5 {
		t.Fatalf("config = %+v", resp.Styles[0].Config)
	}
}

func TestStylesGetRequiresAuth(t *testing.T) {
	h := newHarness(t)
	rec := h.do(http.MethodGet, "/api/prompts/styles", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestStylesCreate(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/prompts/styles",
		`{"key":"brand-new","label":"新风格","systemPrompt":"你是助手","temperature":0.7,"detailLevel":"high","resultOriented":"medium","isDefault":true}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if resp.Style.ID == 0 || resp.Style.Key != "brand-new" || resp.Style.Label != "新风格" {
		t.Fatalf("style = %+v", resp.Style)
	}
	if resp.Style.Temperature != "0.7" {
		t.Fatalf("temperature = %q, want JS String(0.7)", resp.Style.Temperature)
	}
	if resp.Style.DetailLevel == nil || *resp.Style.DetailLevel != "high" {
		t.Fatalf("detailLevel = %+v", resp.Style.DetailLevel)
	}
	if !resp.Style.IsDefault {
		t.Fatalf("isDefault = false")
	}
	// POST 的响应不带 config（createAIStyle 返回原始行）。
	if resp.Style.Config != nil {
		t.Fatalf("config = %+v, want absent", resp.Style.Config)
	}
}

// temperature 缺省 → zod default 0.3 → String(0.3) = "0.3"；isDefault 缺省 false。
func TestStylesCreateAppliesDefaults(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/prompts/styles",
		`{"key":"plain","label":"普通","systemPrompt":"p"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if resp.Style.Temperature != "0.3" || resp.Style.IsDefault {
		t.Fatalf("style = %+v", resp.Style)
	}
	if resp.Style.DetailLevel != nil || resp.Style.ResultOriented != nil {
		t.Fatalf("nullable = %+v", resp.Style)
	}
}

// 0.1 + 0.2 这类 double 的最短往返表示必须与 JS String(number) 一致。
func TestStylesCreateFormatsTemperatureLikeJS(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/prompts/styles",
		`{"key":"precise","label":"精确","systemPrompt":"p","temperature":0.30000000000000004}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if resp.Style.Temperature != "0.30000000000000004" {
		t.Fatalf("temperature = %q", resp.Style.Temperature)
	}
}

func TestStylesCreateValidation(t *testing.T) {
	cases := []struct{ name, body string }{
		{"缺 key", `{"label":"l","systemPrompt":"p"}`},
		{"key 不合法", `{"key":"Bad","label":"l","systemPrompt":"p"}`},
		{"label 为空", `{"key":"k","label":"","systemPrompt":"p"}`},
		{"systemPrompt 为空", `{"key":"k","label":"l","systemPrompt":""}`},
		{"temperature 越界", `{"key":"k","label":"l","systemPrompt":"p","temperature":3}`},
		{"detailLevel 非法", `{"key":"k","label":"l","systemPrompt":"p","detailLevel":"LOW"}`},
		{"body 是 null", `null`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			rec := h.authed(http.MethodPost, "/api/prompts/styles", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			resp := decode[errorResponse](t, rec.Body.Bytes())
			if resp.Error != "Validation failed" || resp.Code != "VALIDATION_ERROR" {
				t.Fatalf("body = %+v", resp)
			}
		})
	}
}

// key 上有 UNIQUE 约束：重复创建落到 catch → 500 CREATE_ERROR。
func TestStylesCreateDuplicateKeyIs500(t *testing.T) {
	h := newHarness(t)
	h.seedStyle("dup", "已有", "p", "0.3", nil, nil, 0, 1_700_000_000)

	rec := h.authed(http.MethodPost, "/api/prompts/styles", `{"key":"dup","label":"另一个","systemPrompt":"p"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "Failed to create style" || resp.Code != "CREATE_ERROR" {
		t.Fatalf("body = %+v", resp)
	}
}

func TestStylesGetByID(t *testing.T) {
	h := newHarness(t)
	detail := "low"
	id := h.seedStyle("my-style", "我的", "prompt", "1", &detail, nil, 0, 1_700_000_000)

	rec := h.authed(http.MethodGet, "/api/prompts/styles/"+itoa(id), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if resp.Style.ID != id || resp.Style.Key != "my-style" || resp.Style.Temperature != "1" {
		t.Fatalf("style = %+v", resp.Style)
	}
	if resp.Style.DetailLevel == nil || *resp.Style.DetailLevel != "low" {
		t.Fatalf("detailLevel = %+v", resp.Style.DetailLevel)
	}

	rec = h.authed(http.MethodGet, "/api/prompts/styles/999", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if code := decode[errorResponse](t, rec.Body.Bytes()).Code; code != "STYLE_NOT_FOUND" {
		t.Fatalf("code = %q", code)
	}
}

// PUT 走 aiStyleSchema.partial()：任何缺失字段都保留旧值，但 temperature 的
// default(0.3) 在 partial 下仍然生效 → 未提供时会写成 "0.3"。
func TestStylesUpdateDefaultsTemperatureAndKeepsOthers(t *testing.T) {
	h := newHarness(t)
	detail := "medium"
	id := h.seedStyle("keep", "旧名", "旧提示", "0.9", &detail, nil, 0, 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/prompts/styles/"+itoa(id), `{"label":"新名"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if resp.Style.Label != "新名" || resp.Style.Key != "keep" || resp.Style.SystemPrompt != "旧提示" {
		t.Fatalf("style = %+v", resp.Style)
	}
	if resp.Style.Temperature != "0.3" {
		t.Fatalf("temperature = %q, want zod default 0.3 applied in partial", resp.Style.Temperature)
	}
	if resp.Style.DetailLevel == nil || *resp.Style.DetailLevel != "medium" {
		t.Fatalf("detailLevel = %+v, want kept", resp.Style.DetailLevel)
	}

	key, label, prompt, temperature, detailLevel, _, _ := h.styleRow(id)
	if key != "keep" || label != "新名" || prompt != "旧提示" || temperature != "0.3" || detailLevel == nil || *detailLevel != "medium" {
		t.Fatalf("row = %q %q %q %q %v", key, label, prompt, temperature, detailLevel)
	}
}

func TestStylesUpdateSetsProvidedFields(t *testing.T) {
	h := newHarness(t)
	id := h.seedStyle("s", "l", "p", "0.3", nil, nil, 0, 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/prompts/styles/"+itoa(id),
		`{"key":"renamed","systemPrompt":"新提示","temperature":1.5,"detailLevel":"high","resultOriented":"low","isDefault":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if resp.Style.Key != "renamed" || resp.Style.SystemPrompt != "新提示" || resp.Style.Temperature != "1.5" {
		t.Fatalf("style = %+v", resp.Style)
	}
	if !resp.Style.IsDefault || resp.Style.DetailLevel == nil || *resp.Style.DetailLevel != "high" {
		t.Fatalf("style = %+v", resp.Style)
	}
}

func TestStylesUpdateValidation(t *testing.T) {
	h := newHarness(t)
	id := h.seedStyle("s", "l", "p", "0.3", nil, nil, 0, 1_700_000_000)

	cases := []struct{ name, body string }{
		{"label 为空", `{"label":""}`},
		{"temperature 越界", `{"temperature":-1}`},
		{"detailLevel 为 null", `{"detailLevel":null}`},
		{"body 是 null", `null`},
		{"body 是数组", `[]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.authed(http.MethodPut, "/api/prompts/styles/"+itoa(id), tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// 校验先于存在性检查：不存在的 id + 非法 body → 400（不是 404）。
func TestStylesUpdateValidationBeforeExistence(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPut, "/api/prompts/styles/999", `{"label":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	rec = h.authed(http.MethodPut, "/api/prompts/styles/999", `{"label":"ok"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}

// deleteAIStyle：非默认且不是最后一个 → 成功；并清除引用。
func TestStylesDeleteClearsReferences(t *testing.T) {
	h := newHarness(t)
	styleID := h.seedStyle("technical", "技术", "p", "0.4", nil, nil, 0, 1_700_000_000)
	h.seedStyle("formal", "正式", "p", "0.3", nil, nil, 1, 1_700_000_000)

	if _, err := h.sqlDB.Exec(
		`INSERT INTO templates (name, content, ai_style, created_at, updated_at) VALUES ('t', 'c', 'technical', ?, ?)`,
		int64(1_700_000_000), int64(1_700_000_000),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO reports (title, content, week_start, week_end, ai_style_override, created_at, updated_at)
		 VALUES ('r', 'c', '2024-01-01', '2024-01-07', 'technical', ?, ?)`,
		int64(1_700_000_000), int64(1_700_000_000),
	); err != nil {
		t.Fatal(err)
	}

	rec := h.authed(http.MethodDelete, "/api/prompts/styles/"+itoa(styleID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"success":true`) || !strings.Contains(rec.Body.String(), `"message":"Style deleted"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}

	var aiStyle string
	if err := h.sqlDB.QueryRow(`SELECT ai_style FROM templates`).Scan(&aiStyle); err != nil {
		t.Fatal(err)
	}
	if aiStyle != "formal" {
		t.Fatalf("template ai_style = %q, want formal", aiStyle)
	}
	var override *string
	if err := h.sqlDB.QueryRow(`SELECT ai_style_override FROM reports`).Scan(&override); err != nil {
		t.Fatal(err)
	}
	if override != nil {
		t.Fatalf("report ai_style_override = %v, want NULL", override)
	}
}

// route.ts 的状态码推导是 `error === 'Style not found' ? 404 : 400`，而 lib 返回
// 中文错误串 → 业务失败恒为 400。
func TestStylesDeleteFailuresAre400(t *testing.T) {
	t.Run("不存在", func(t *testing.T) {
		h := newHarness(t)
		h.seedStyle("only", "唯一", "p", "0.3", nil, nil, 0, 1_700_000_000)

		rec := h.authed(http.MethodDelete, "/api/prompts/styles/999", "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
		}
		resp := decode[errorResponse](t, rec.Body.Bytes())
		if resp.Error != "风格不存在" || resp.Code != "DELETE_ERROR" {
			t.Fatalf("body = %+v", resp)
		}
	})

	t.Run("最后一个风格", func(t *testing.T) {
		h := newHarness(t)
		id := h.seedStyle("only", "唯一", "p", "0.3", nil, nil, 0, 1_700_000_000)

		rec := h.authed(http.MethodDelete, "/api/prompts/styles/"+itoa(id), "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
		}
		if resp := decode[errorResponse](t, rec.Body.Bytes()); resp.Error != "无法删除最后一个风格" {
			t.Fatalf("body = %+v", resp)
		}
	})

	t.Run("默认风格", func(t *testing.T) {
		h := newHarness(t)
		id := h.seedStyle("default", "默认", "p", "0.3", nil, nil, 1, 1_700_000_000)
		h.seedStyle("other", "其他", "p", "0.3", nil, nil, 0, 1_700_000_000)

		rec := h.authed(http.MethodDelete, "/api/prompts/styles/"+itoa(id), "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
		}
		if resp := decode[errorResponse](t, rec.Body.Bytes()); resp.Error != "默认风格不能删除，请先将其他风格设为默认" {
			t.Fatalf("body = %+v", resp)
		}
	})
}

func TestStylesSetDefault(t *testing.T) {
	h := newHarness(t)
	first := h.seedStyle("formal", "正式", "p", "0.3", nil, nil, 1, 1_700_000_000)
	second := h.seedStyle("technical", "技术", "p", "0.4", nil, nil, 0, 1_700_000_001)

	rec := h.authed(http.MethodPatch, "/api/prompts/styles/"+itoa(second), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[styleResponse](t, rec.Body.Bytes())
	if !resp.Style.IsDefault || resp.Style.Key != "technical" {
		t.Fatalf("style = %+v", resp.Style)
	}

	var firstDefault, secondDefault int64
	if err := h.sqlDB.QueryRow(`SELECT is_default FROM ai_styles WHERE id = ?`, first).Scan(&firstDefault); err != nil {
		t.Fatal(err)
	}
	if err := h.sqlDB.QueryRow(`SELECT is_default FROM ai_styles WHERE id = ?`, second).Scan(&secondDefault); err != nil {
		t.Fatal(err)
	}
	if firstDefault != 0 || secondDefault != 1 {
		t.Fatalf("defaults = %d / %d", firstDefault, secondDefault)
	}

	rec = h.authed(http.MethodPatch, "/api/prompts/styles/999", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
