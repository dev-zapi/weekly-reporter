package ai_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件是 src/app/api/ai/polish-event/route.test.ts 的 Go 同用例集
// （ADR-0029：route.test 随票转 Go httptest，同 PR 删 vitest 侧）。
//
// 与 vitest 的差异只在打桩层级：TS 侧 mock 掉 polishEvent / getAIStyle，这里让
// 真实代码走完整链路（风格查库 → aiclient 发 HTTP → 解析），provider 一侧用
// httptest 的 mock 响应代替。这样断言的是可观测契约（状态码、body 形状、
// 提示词与温度是否按风格送到 provider），而不是内部调用。

type polishResponse struct {
	PolishedContent string `json:"polishedContent"`
	Style           string `json:"style"`
	Message         string `json:"message"`
}

type errorResponse struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	Details string `json:"details"`
}

func decodeJSONInto(t *testing.T, body []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
}

// setupPolish 装配 polish-event 的公共夹具：一行 ai_config 指向 mock provider，
// 四条内置风格照生产库的形态入库（formal 为默认）。
func setupPolish(t *testing.T) *harness {
	t.Helper()

	h := newHarness(t)
	h.seedAIConfig("openai", h.mock.url(), "mock-model")
	h.seedStyle("formal", "正式汇报", "Test prompt", "0.3", true)
	h.seedStyle("technical", "技术研发", "技术研发提示词", "0.4", false)
	h.seedStyle("concise", "极简干练", "极简提示词", "0.2", false)
	h.seedStyle("detailed", "深度复盘", "深度提示词", "0.5", false)
	h.mock.setText(`{"polishedContent":"润色后的内容"}`)
	return h
}

func TestPolishEventRejectsEmptyContent(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{"eventContent":""}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Event content is required" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
	// 校验在风格查询与模型调用之前：provider 不该收到请求。
	if len(h.mock.received()) != 0 {
		t.Fatalf("provider called %d times, want 0", len(h.mock.received()))
	}
}

func TestPolishEventRejectsMissingContent(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Event content is required" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestPolishEventRejectsNonStringContent(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{"eventContent":123}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Event content is required" || resp.Code != "INVALID_INPUT" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestPolishEventUsesStyleFromTemplate(t *testing.T) {
	h := setupPolish(t)
	h.seedTemplate(1, "technical")

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content","templateId":1}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp polishResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Style != "技术研发" {
		t.Fatalf("style = %q, want 技术研发", resp.Style)
	}

	// 模板指向的风格提示词与温度必须真的送到 provider。
	request := h.mock.lastRequest()
	if request.Path != "/responses" {
		t.Fatalf("provider path = %q", request.Path)
	}
	prompt := promptOf(t, request)
	if prompt != "技术研发提示词\n\n请润色以下内容。保持原意不变，仅优化表达方式、补充数据感、调整句式。直接返回润色后文本，不要添加任何解释。\n内容中的 @数字（如 @7008）是对另一事件的引用，必须原样保留，不改写、不展开、不删除。\n\nTest content" {
		t.Fatalf("prompt = %q", prompt)
	}
	if temperature := request.Body["temperature"]; temperature != 0.4 {
		t.Fatalf("temperature = %v, want 0.4", temperature)
	}
}

func TestPolishEventUsesStyleOverride(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content","styleOverride":"technical"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp polishResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Style != "技术研发" {
		t.Fatalf("style = %q, want 技术研发", resp.Style)
	}
}

// polish-event 的选择顺序是 styleOverride → templateId（另两条路由相反）。
func TestPolishEventPrioritizesStyleOverrideOverTemplate(t *testing.T) {
	h := setupPolish(t)
	h.seedTemplate(1, "technical")

	rec := h.do("/api/ai/polish-event",
		`{"eventContent":"Test content","templateId":1,"styleOverride":"concise"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp polishResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Style != "极简干练" {
		t.Fatalf("style = %q, want 极简干练", resp.Style)
	}
	if temperature := h.mock.lastRequest().Body["temperature"]; temperature != 0.2 {
		t.Fatalf("temperature = %v, want 0.2", temperature)
	}
}

func TestPolishEventFallsBackToDefaultStyle(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp polishResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Style != "正式汇报" {
		t.Fatalf("style = %q, want 正式汇报", resp.Style)
	}
}

// 数据库完全没有风格行时回退到 styles.ts 的硬编码「正式汇报」。
func TestPolishEventFallsBackToHardcodedStyleWithoutRows(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai", h.mock.url(), "mock-model")
	h.mock.setText(`{"polishedContent":"x"}`)

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp polishResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Style != "正式汇报" {
		t.Fatalf("style = %q, want 正式汇报", resp.Style)
	}
	if temperature := h.mock.lastRequest().Body["temperature"]; temperature != 0.3 {
		t.Fatalf("temperature = %v, want 0.3", temperature)
	}
}

func TestPolishEventReturnsPolishedContent(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp polishResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.PolishedContent != "润色后的内容" {
		t.Fatalf("polishedContent = %q", resp.PolishedContent)
	}
	if resp.Message != "Event polished successfully" {
		t.Fatalf("message = %q", resp.Message)
	}
}

func TestPolishEventReturnsAINotConfigured(t *testing.T) {
	// 没有 ai_config 行：ai.ts 的 getModel 抛 AIConfigError。
	h := newHarness(t)
	h.seedStyle("formal", "正式汇报", "Test prompt", "0.3", true)

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content"}`, testPassword)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Code != "AI_NOT_CONFIGURED" {
		t.Fatalf("code = %q, want AI_NOT_CONFIGURED", resp.Code)
	}
	if resp.Error != "AI_API_KEY 未配置" {
		t.Fatalf("error = %q", resp.Error)
	}
}

func TestPolishEventHandlesInvalidJSONBody(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", "invalid json", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Failed to polish event" || resp.Code != "POLISH_ERROR" {
		t.Fatalf("error body = %+v", resp)
	}
}

func TestPolishEventHandlesStyleFetchErrors(t *testing.T) {
	h := setupPolish(t)
	h.seedTemplate(1, "technical")
	h.breakDB()

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content","templateId":1}`, testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp errorResponse
	decodeJSONInto(t, rec.Body.Bytes(), &resp)
	if resp.Error != "Failed to polish event" || resp.Code != "POLISH_ERROR" {
		t.Fatalf("error body = %+v", resp)
	}
}

// provider 返回非 2xx / 输出不符合 schema 都归到同一个 500 分支。
func TestPolishEventHandlesProviderFailure(t *testing.T) {
	cases := []struct {
		name  string
		setup func(*mockProvider)
	}{
		{"http error", func(m *mockProvider) {
			m.setReply(func(recordedRequest) (int, string) {
				return http.StatusInternalServerError, `{"error":{"message":"boom"}}`
			})
		}},
		{"unparsable output", func(m *mockProvider) { m.setText("not json") }},
		{"schema mismatch", func(m *mockProvider) { m.setText(`{"polishedContent":123}`) }},
		{"missing field", func(m *mockProvider) { m.setText(`{}`) }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := setupPolish(t)
			tc.setup(h.mock)

			rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content"}`, testPassword)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			var resp errorResponse
			decodeJSONInto(t, rec.Body.Bytes(), &resp)
			if resp.Error != "Failed to polish event" || resp.Code != "POLISH_ERROR" {
				t.Fatalf("error body = %+v", resp)
			}
			if resp.Details == "" {
				t.Fatalf("details must carry the diagnostic error text")
			}
		})
	}
}

func TestPolishEventRequiresAuth(t *testing.T) {
	h := setupPolish(t)

	rec := h.do("/api/ai/polish-event", `{"eventContent":"Test content"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}

// promptOf 取 Responses 请求体里那条 user 消息的文本。
func promptOf(t *testing.T, request recordedRequest) string {
	t.Helper()

	input, _ := request.Body["input"].([]any)
	if len(input) != 1 {
		t.Fatalf("input = %v", request.Body["input"])
	}
	message, _ := input[0].(map[string]any)
	content, _ := message["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("content = %v", message["content"])
	}
	part, _ := content[0].(map[string]any)
	text, _ := part["text"].(string)
	return text
}
