package prompts_test

import (
	"net/http"
	"strings"
	"testing"
)

// 本文件是 /api/prompts/system 的 httptest 用例集
// （src/app/api/prompts/system/route.ts + src/lib/ai/seed.ts）。

type systemPromptJSON struct {
	ID         int64  `json:"id"`
	Key        string `json:"key"`
	Label      string `json:"label"`
	PromptText string `json:"promptText"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

type systemPromptsResponse struct {
	Prompts []systemPromptJSON `json:"prompts"`
}

type systemPromptResponse struct {
	Prompt systemPromptJSON `json:"prompt"`
}

// ensureSeed 补齐两个内置提示词；排序是 key 升序（'check' < 'generate'）。
func TestSystemPromptsGetSeedsBuiltins(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodGet, "/api/prompts/system", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[systemPromptsResponse](t, rec.Body.Bytes())
	if len(resp.Prompts) != 2 {
		t.Fatalf("prompts = %d, want 2 seeded", len(resp.Prompts))
	}
	if resp.Prompts[0].Key != "check" || resp.Prompts[0].Label != "写作建议" {
		t.Fatalf("prompts[0] = %+v", resp.Prompts[0])
	}
	if resp.Prompts[1].Key != "generate" || resp.Prompts[1].Label != "终版生成" {
		t.Fatalf("prompts[1] = %+v", resp.Prompts[1])
	}
	if !strings.Contains(resp.Prompts[0].PromptText, "{{content}}") {
		t.Fatalf("check prompt = %q", resp.Prompts[0].PromptText)
	}
	if resp.Prompts[0].CreatedAt == "" || resp.Prompts[0].UpdatedAt == "" {
		t.Fatalf("timestamps missing: %+v", resp.Prompts[0])
	}
}

// system prompts 的 seed 是「按 key 缺哪个补哪个」：已有的行保留。
func TestSystemPromptsSeedOnlyFillsMissing(t *testing.T) {
	h := newHarness(t)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO system_prompts (key, label, prompt_text, created_at, updated_at) VALUES ('check', '自定义', '自定义文本', ?, ?)`,
		int64(1_700_000_000), int64(1_700_000_000),
	); err != nil {
		t.Fatal(err)
	}

	rec := h.authed(http.MethodGet, "/api/prompts/system", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decode[systemPromptsResponse](t, rec.Body.Bytes())
	if len(resp.Prompts) != 2 {
		t.Fatalf("prompts = %d, want 2", len(resp.Prompts))
	}
	if resp.Prompts[0].PromptText != "自定义文本" {
		t.Fatalf("check prompt = %q, want preserved", resp.Prompts[0].PromptText)
	}
}

func TestSystemPromptsGetRequiresAuth(t *testing.T) {
	h := newHarness(t)
	rec := h.do(http.MethodGet, "/api/prompts/system", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestSystemPromptsUpdate(t *testing.T) {
	h := newHarness(t)
	// 先 seed（PUT 之前 route.ts 不调用 ensureSeed，所以这里手动建行）。
	if rec := h.authed(http.MethodGet, "/api/prompts/system", ""); rec.Code != http.StatusOK {
		t.Fatalf("seed failed: %d", rec.Code)
	}

	rec := h.authed(http.MethodPut, "/api/prompts/system", `{"key":"check","promptText":"新的建议提示"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[systemPromptResponse](t, rec.Body.Bytes())
	if resp.Prompt.Key != "check" || resp.Prompt.PromptText != "新的建议提示" || resp.Prompt.Label != "写作建议" {
		t.Fatalf("prompt = %+v", resp.Prompt)
	}
}

func TestSystemPromptsUpdateValidation(t *testing.T) {
	cases := []struct{ name, body, wantError, wantCode string }{
		{"promptText 为空", `{"key":"check","promptText":""}`, "Validation failed", "VALIDATION_ERROR"},
		{"缺 promptText", `{"key":"check"}`, "Validation failed", "VALIDATION_ERROR"},
		{"key 非法", `{"key":"nope","promptText":"x"}`, "Invalid prompt key", "VALIDATION_ERROR"},
		{"缺 key", `{"promptText":"x"}`, "Invalid prompt key", "VALIDATION_ERROR"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			if rec := h.authed(http.MethodGet, "/api/prompts/system", ""); rec.Code != http.StatusOK {
				t.Fatalf("seed failed: %d", rec.Code)
			}

			rec := h.authed(http.MethodPut, "/api/prompts/system", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			resp := decode[errorResponse](t, rec.Body.Bytes())
			if resp.Error != tc.wantError || resp.Code != tc.wantCode {
				t.Fatalf("body = %+v", resp)
			}
		})
	}
}

// 合法 key 但库里没有那一行 → 404 NOT_FOUND（PUT 不触发 seed）。
func TestSystemPromptsUpdateMissingRowIs404(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPut, "/api/prompts/system", `{"key":"check","promptText":"x"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "System prompt not found" || resp.Code != "NOT_FOUND" {
		t.Fatalf("body = %+v", resp)
	}
}
