package templates_test

import (
	"net/http"
	"strings"
	"testing"
)

// 本文件是 /api/templates/clone 的 httptest 用例集（src/app/api/templates/clone/route.ts）。

type cloneResponse struct {
	Template templateJSON `json:"template"`
	Message  string       `json:"message"`
}

func TestTemplatesCloneOfficial(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/templates/clone", `{"sourceId":"official-tech-dev"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[cloneResponse](t, rec.Body.Bytes())
	if resp.Message != "Template cloned successfully" {
		t.Fatalf("message = %q", resp.Message)
	}
	got := resp.Template
	if got.Name != "技术研发专属周报模板" || got.AiStyle != "technical" {
		t.Fatalf("template = %+v", got)
	}
	if got.SourceTemplateID == nil || *got.SourceTemplateID != "official-tech-dev" {
		t.Fatalf("sourceTemplateId = %+v", got.SourceTemplateID)
	}
	// 克隆不复制 description/tags。
	if got.Description != nil || got.Tags != nil {
		t.Fatalf("nullable fields = %+v", got)
	}
	if !strings.Contains(got.Content, "开发进度") {
		t.Fatalf("content = %q", got.Content)
	}
}

func TestTemplatesCloneOverridesNameAndContent(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/templates/clone", `{"sourceId":"official-minimal","name":"自定义名","content":"自定义正文"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	got := decode[cloneResponse](t, rec.Body.Bytes()).Template
	if got.Name != "自定义名" || got.Content != "自定义正文" {
		t.Fatalf("template = %+v", got)
	}
	// 风格仍来自来源模板。
	if got.AiStyle != "concise" {
		t.Fatalf("aiStyle = %q", got.AiStyle)
	}
}

// `validated.content || sourceTemplate.content`：空串是 falsy → 回落来源正文。
func TestTemplatesCloneEmptyContentFallsBack(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/templates/clone", `{"sourceId":"official-minimal","content":""}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	got := decode[cloneResponse](t, rec.Body.Bytes()).Template
	if !strings.Contains(got.Content, "本周重点") {
		t.Fatalf("content = %q", got.Content)
	}
}

func TestTemplatesCloneUserTemplate(t *testing.T) {
	h := newHarness(t)
	description := "来源描述"
	id := h.seedTemplate("用户模板", "用户正文", &description, nil, "detailed", 1_700_000_000)

	rec := h.authed(http.MethodPost, "/api/templates/clone", `{"sourceId":"user-`+itoa(id)+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	got := decode[cloneResponse](t, rec.Body.Bytes()).Template
	if got.Name != "用户模板" || got.Content != "用户正文" || got.AiStyle != "detailed" {
		t.Fatalf("template = %+v", got)
	}
}

func TestTemplatesCloneSourceNotFound(t *testing.T) {
	cases := []string{
		`{"sourceId":"official-nope"}`,
		`{"sourceId":"user-999"}`,
		`{"sourceId":"nope"}`,
		`{"sourceId":"user-abc"}`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			h := newHarness(t)
			rec := h.authed(http.MethodPost, "/api/templates/clone", body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			resp := decode[errorResponse](t, rec.Body.Bytes())
			if resp.Error != "Source template not found" || resp.Code != "TEMPLATE_NOT_FOUND" {
				t.Fatalf("body = %+v", resp)
			}
		})
	}
}

func TestTemplatesCloneValidation(t *testing.T) {
	cases := []struct{ name, body string }{
		{"缺少 sourceId", `{}`},
		{"sourceId 为空", `{"sourceId":""}`},
		{"name 为 null", `{"sourceId":"official-minimal","name":null}`},
		{"body 是 null", `null`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			rec := h.authed(http.MethodPost, "/api/templates/clone", tc.body)
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
