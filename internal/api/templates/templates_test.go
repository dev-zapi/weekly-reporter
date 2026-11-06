package templates_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 /api/templates 与 /api/templates/{id} 的 httptest 用例集，行为以
// src/app/api/templates 下的 route.ts 为唯一事实源（ADR-0029）。

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

type officialTemplateJSON struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Content     string   `json:"content"`
	AiStyle     string   `json:"aiStyle"`
}

type listResponse struct {
	Official []officialTemplateJSON `json:"official"`
	User     []templateJSON         `json:"user"`
}

type templateResponse struct {
	Template templateJSON `json:"template"`
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

// seedTemplate 直接写一行模板，created_at/updated_at 固定，便于断言更新时间。
func (h *harness) seedTemplate(name, content string, description, tags *string, aiStyle string, updatedAt int64) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO templates (name, content, description, tags, source_template_id, ai_style, created_at, updated_at)
		 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
		name, content, description, tags, aiStyle, int64(1_700_000_000), updatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed template: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) templateRow(id int64) (name, content string, description, tags *string, aiStyle string, updatedAt int64) {
	h.t.Helper()
	if err := h.sqlDB.QueryRow(
		`SELECT name, content, description, tags, ai_style, updated_at FROM templates WHERE id = ?`, id,
	).Scan(&name, &content, &description, &tags, &aiStyle, &updatedAt); err != nil {
		h.t.Fatalf("read template %d: %v", id, err)
	}
	return
}

func TestTemplatesGetReturnsOfficialAndUser(t *testing.T) {
	h := newHarness(t)
	description := "desc"
	tags := "技术,周报"
	userID := h.seedTemplate("我的模板", "正文", &description, &tags, "technical", 1_700_000_100)

	rec := h.authed(http.MethodGet, "/api/templates", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[listResponse](t, rec.Body.Bytes())

	if len(resp.Official) != 4 {
		t.Fatalf("official = %d, want 4", len(resp.Official))
	}
	// 顺序是契约：official-general 在最前（客户端按数组顺序渲染）。
	if resp.Official[0].ID != "official-general" || resp.Official[0].AiStyle != "formal" {
		t.Fatalf("official[0] = %+v", resp.Official[0])
	}
	if len(resp.Official[0].Tags) != 2 || resp.Official[0].Tags[0] != "通用" {
		t.Fatalf("official[0].tags = %+v", resp.Official[0].Tags)
	}

	if len(resp.User) != 1 {
		t.Fatalf("user = %+v", resp.User)
	}
	got := resp.User[0]
	if got.ID != userID || got.Name != "我的模板" || got.AiStyle != "technical" {
		t.Fatalf("user[0] = %+v", got)
	}
	if got.Description == nil || *got.Description != "desc" || got.Tags == nil || *got.Tags != "技术,周报" {
		t.Fatalf("user[0] nullable fields = %+v", got)
	}
	// drizzle 的 timestamp mode：秒 → Date → JSON 是 ISO。
	if got.CreatedAt != "2023-11-14T22:13:20.000Z" || got.UpdatedAt != "2023-11-14T22:15:00.000Z" {
		t.Fatalf("timestamps = %s / %s", got.CreatedAt, got.UpdatedAt)
	}
}

func TestTemplatesGetEmptyUserIsArray(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodGet, "/api/templates", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"user":[]`) {
		t.Fatalf("body = %s, want user:[]", rec.Body.String())
	}
}

func TestTemplatesGetRequiresAuth(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/templates", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestTemplatesGetReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.authed(http.MethodGet, "/api/templates", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "Failed to load templates" || resp.Code != "FETCH_ERROR" || resp.Details == "" {
		t.Fatalf("body = %+v", resp)
	}
}

func TestTemplatesCreate(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/templates", `{"name":"新模板","content":"正文","description":"d","tags":"t","aiStyle":"concise"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[templateResponse](t, rec.Body.Bytes())
	if resp.Template.ID == 0 || resp.Template.Name != "新模板" || resp.Template.AiStyle != "concise" {
		t.Fatalf("template = %+v", resp.Template)
	}
	if resp.Template.Description == nil || *resp.Template.Description != "d" {
		t.Fatalf("description = %+v", resp.Template.Description)
	}
	if resp.Template.SourceTemplateID != nil {
		t.Fatalf("sourceTemplateId = %+v, want null", resp.Template.SourceTemplateID)
	}

	name, content, description, tags, aiStyle, _ := h.templateRow(resp.Template.ID)
	if name != "新模板" || content != "正文" || description == nil || *description != "d" || tags == nil || *tags != "t" || aiStyle != "concise" {
		t.Fatalf("stored row = %q %q %v %v %q", name, content, description, tags, aiStyle)
	}
}

// 未提供 description/tags 落 NULL；aiStyle 走列默认值 'formal'
// （drizzle 对带默认值的列会在 insert 时填默认值）。
func TestTemplatesCreateAppliesDefaults(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/templates", `{"name":"n","content":"c"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[templateResponse](t, rec.Body.Bytes())
	if resp.Template.Description != nil || resp.Template.Tags != nil {
		t.Fatalf("nullable fields = %+v", resp.Template)
	}
	if resp.Template.AiStyle != "formal" {
		t.Fatalf("aiStyle = %q, want formal", resp.Template.AiStyle)
	}
}

func TestTemplatesCreateValidation(t *testing.T) {
	cases := []struct{ name, body string }{
		{"缺少 name", `{"content":"c"}`},
		{"name 为空", `{"name":"","content":"c"}`},
		{"name 超长", `{"name":"` + strings.Repeat("a", 101) + `","content":"c"}`},
		{"缺少 content", `{"name":"n"}`},
		{"content 为空", `{"name":"n","content":""}`},
		{"description 超长", `{"name":"n","content":"c","description":"` + strings.Repeat("a", 201) + `"}`},
		{"description 为 null", `{"name":"n","content":"c","description":null}`},
		{"aiStyle 非法", `{"name":"n","content":"c","aiStyle":"Formal"}`},
		{"body 是数组", `[]`},
		{"body 是 null", `null`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			rec := h.authed(http.MethodPost, "/api/templates", tc.body)
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

// zod 的长度是 UTF-16 码元数：100 个增补平面字符 = 200 码元 → 超 max(100)。
func TestTemplatesCreateCountsUTF16Length(t *testing.T) {
	h := newHarness(t)
	rec := h.authed(http.MethodPost, "/api/templates", `{"name":"`+strings.Repeat("😀", 100)+`","content":"c"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestTemplatesCreateInvalidJSONIs500(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPost, "/api/templates", `{"name":`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "Failed to create template" || resp.Code != "CREATE_ERROR" {
		t.Fatalf("body = %+v", resp)
	}
}

func TestTemplatesGetByID(t *testing.T) {
	h := newHarness(t)
	id := h.seedTemplate("名字", "正文", nil, nil, "formal", 1_700_000_000)

	rec := h.authed(http.MethodGet, "/api/templates/"+itoa(id), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[templateResponse](t, rec.Body.Bytes())
	if resp.Template.ID != id || resp.Template.Name != "名字" || resp.Template.Description != nil {
		t.Fatalf("template = %+v", resp.Template)
	}
}

// parseInt('12abc') === 12；parseInt('abc') === NaN → drizzle 绑定后查不到 → 404。
func TestTemplatesGetByIDParsesLikeJS(t *testing.T) {
	h := newHarness(t)
	h.seedTemplate("名字", "正文", nil, nil, "formal", 1_700_000_000)

	rec := h.authed(http.MethodGet, "/api/templates/1abc", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	rec = h.authed(http.MethodGet, "/api/templates/abc", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "Template not found" || resp.Code != "TEMPLATE_NOT_FOUND" {
		t.Fatalf("body = %+v", resp)
	}
}

func TestTemplatesGetByIDReturns500OnDatabaseError(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.authed(http.MethodGet, "/api/templates/1", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "Failed to load template" || resp.Code != "FETCH_ERROR" {
		t.Fatalf("body = %+v", resp)
	}
}

// style-only 分支：body 只有 aiStyle 一个键，只改风格与 updatedAt。
func TestTemplatesUpdateStyleOnly(t *testing.T) {
	h := newHarness(t)
	description := "保留"
	tags := "保留tag"
	id := h.seedTemplate("名字", "正文", &description, &tags, "formal", 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/templates/"+itoa(id), `{"aiStyle":"technical"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[templateResponse](t, rec.Body.Bytes())
	if resp.Template.AiStyle != "technical" || resp.Template.Name != "名字" {
		t.Fatalf("template = %+v", resp.Template)
	}

	name, content, desc, tags2, aiStyle, updatedAt := h.templateRow(id)
	if name != "名字" || content != "正文" || desc == nil || *desc != "保留" || tags2 == nil || *tags2 != "保留tag" {
		t.Fatalf("row changed: %q %q %v %v", name, content, desc, tags2)
	}
	if aiStyle != "technical" {
		t.Fatalf("aiStyle = %q", aiStyle)
	}
	if updatedAt <= 1_700_000_000 {
		t.Fatalf("updatedAt = %d, want it bumped", updatedAt)
	}
}

// body 是空对象 → Object.keys([]).every → true → style-only，只写 updated_at。
func TestTemplatesUpdateEmptyObjectOnlyTouchesUpdatedAt(t *testing.T) {
	h := newHarness(t)
	description := "保留"
	id := h.seedTemplate("名字", "正文", &description, nil, "formal", 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/templates/"+itoa(id), `{}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[templateResponse](t, rec.Body.Bytes())
	if resp.Template.AiStyle != "formal" || resp.Template.Description == nil || *resp.Template.Description != "保留" {
		t.Fatalf("template = %+v", resp.Template)
	}
	_, _, desc, _, _, updatedAt := h.templateRow(id)
	if desc == nil || *desc != "保留" {
		t.Fatalf("description = %v", desc)
	}
	if updatedAt <= 1_700_000_000 {
		t.Fatalf("updatedAt = %d, want it bumped", updatedAt)
	}
}

// 完整更新：name/content 必填；description/tags 缺省时保留旧值
// （drizzle 的 update().set() 省略 undefined 键）。
func TestTemplatesUpdateFull(t *testing.T) {
	h := newHarness(t)
	description := "旧描述"
	tags := "旧tag"
	id := h.seedTemplate("旧名", "旧正文", &description, &tags, "formal", 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/templates/"+itoa(id), `{"name":"新名","content":"新正文","aiStyle":"concise"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[templateResponse](t, rec.Body.Bytes())
	if resp.Template.Name != "新名" || resp.Template.Content != "新正文" || resp.Template.AiStyle != "concise" {
		t.Fatalf("template = %+v", resp.Template)
	}
	if resp.Template.Description == nil || *resp.Template.Description != "旧描述" || resp.Template.Tags == nil || *resp.Template.Tags != "旧tag" {
		t.Fatalf("nullable fields = %+v", resp.Template)
	}
}

// 显式空串会覆盖 description/tags（与「缺省保留」不同）。
func TestTemplatesUpdateExplicitEmptyStringOverwrites(t *testing.T) {
	h := newHarness(t)
	description := "旧描述"
	tags := "旧tag"
	id := h.seedTemplate("旧名", "旧正文", &description, &tags, "formal", 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/templates/"+itoa(id), `{"name":"新名","content":"新正文","description":"","tags":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	_, _, desc, tags2, aiStyle, _ := h.templateRow(id)
	if desc == nil || *desc != "" || tags2 == nil || *tags2 != "" {
		t.Fatalf("nullable = %v %v", desc, tags2)
	}
	// aiStyle 缺省时保留旧值（validated.aiStyle ?? template[0].aiStyle）。
	if aiStyle != "formal" {
		t.Fatalf("aiStyle = %q", aiStyle)
	}
}

func TestTemplatesUpdateValidation(t *testing.T) {
	h := newHarness(t)
	id := h.seedTemplate("名字", "正文", nil, nil, "formal", 1_700_000_000)

	cases := []struct{ name, body string }{
		{"缺 content", `{"name":"n"}`},
		{"name 为空", `{"name":"","content":"c"}`},
		{"aiStyle 非法", `{"name":"n","content":"c","aiStyle":"Bad"}`},
		{"body 是数组", `[]`},
		{"body 是标量", `42`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.authed(http.MethodPut, "/api/templates/"+itoa(id), tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// JSON null 的 body 在 `Object.keys(null)` 处抛 TypeError → 500 UPDATE_ERROR。
func TestTemplatesUpdateNullBodyIs500(t *testing.T) {
	h := newHarness(t)
	id := h.seedTemplate("名字", "正文", nil, nil, "formal", 1_700_000_000)

	rec := h.authed(http.MethodPut, "/api/templates/"+itoa(id), `null`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Error != "Failed to update template" || resp.Code != "UPDATE_ERROR" {
		t.Fatalf("body = %+v", resp)
	}
}

func TestTemplatesUpdateNotFound(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodPut, "/api/templates/999", `{"name":"n","content":"c"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Code != "TEMPLATE_NOT_FOUND" {
		t.Fatalf("body = %+v", resp)
	}
}

func TestTemplatesDelete(t *testing.T) {
	h := newHarness(t)
	id := h.seedTemplate("名字", "正文", nil, nil, "formal", 1_700_000_000)

	rec := h.authed(http.MethodDelete, "/api/templates/"+itoa(id), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"success":true`) || !strings.Contains(rec.Body.String(), `"message":"Template deleted"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}

	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM templates WHERE id = ?`, id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("row still present")
	}
}

func TestTemplatesDeleteNotFound(t *testing.T) {
	h := newHarness(t)

	rec := h.authed(http.MethodDelete, "/api/templates/999", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decode[errorResponse](t, rec.Body.Bytes())
	if resp.Code != "TEMPLATE_NOT_FOUND" {
		t.Fatalf("body = %+v", resp)
	}
}

func itoa(v int64) string {
	const digits = "0123456789"
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for v > 0 {
		pos--
		buf[pos] = digits[v%10]
		v /= 10
	}
	return string(buf[pos:])
}
