package settings_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/settings/ai/test/route.ts 的 Go 同用例集：未配置 400、
// 三协议的 mock provider 端点成功/失败形状，以及 DB 故障的 TEST_ERROR。

func providerChatOK() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}
}

func providerResponsesOK() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp-1","object":"response","created_at":1,"model":"m","status":"completed","output":[{"type":"message","id":"msg-1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hi","annotations":[]}]}]}`))
	}
}

func providerMessagesOK() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg-1","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"Hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`))
	}
}

func TestConnectionTestUnconfigured(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	h.assertError(rec, http.StatusBadRequest, "AI is not configured", "AI_NOT_CONFIGURED")
}

func TestConnectionTestOpenAICompatible(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerChatOK())
	h.seedAIConfig("openai-compatible", h.provider.URL, "compat-key", "compat-model", nil, nil, 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	// testConnection 成功时 error 是 undefined → JSON.stringify 丢掉该键。
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %s, want {\"ok\":true}", got)
	}

	reqs := h.providerRequests()
	if len(reqs) != 1 {
		t.Fatalf("provider requests = %d, want 1", len(reqs))
	}
	req := reqs[0]
	if req.Method != http.MethodPost || req.Path != "/chat/completions" {
		t.Fatalf("request = %s %s", req.Method, req.Path)
	}
	if req.Header.Get("Authorization") != "Bearer compat-key" {
		t.Fatalf("Authorization = %q", req.Header.Get("Authorization"))
	}
	body := decodeProviderBody(t, req.Body)
	if body["model"] != "compat-model" {
		t.Fatalf("body model = %v", body["model"])
	}
	if body["max_tokens"] != float64(5) {
		t.Fatalf("body max_tokens = %v, want 5 (maxOutputTokens)", body["max_tokens"])
	}
}

func TestConnectionTestOpenAIResponses(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerResponsesOK())
	h.seedAIConfig("openai", h.provider.URL+"/v1", "responses-key", "responses-model", nil, nil, 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %s, want {\"ok\":true}", got)
	}

	reqs := h.providerRequests()
	if len(reqs) != 1 || reqs[0].Path != "/v1/responses" {
		t.Fatalf("provider requests = %+v", reqs)
	}
	if reqs[0].Header.Get("Authorization") != "Bearer responses-key" {
		t.Fatalf("Authorization = %q", reqs[0].Header.Get("Authorization"))
	}
	body := decodeProviderBody(t, reqs[0].Body)
	if body["model"] != "responses-model" || body["max_output_tokens"] != float64(5) {
		t.Fatalf("body = %v", body)
	}
}

func TestConnectionTestAnthropic(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerMessagesOK())
	h.seedAIConfig("anthropic", h.provider.URL, "ant-key", "claude-model", nil, nil, 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %s, want {\"ok\":true}", got)
	}

	reqs := h.providerRequests()
	if len(reqs) != 1 || reqs[0].Path != "/messages" {
		t.Fatalf("provider requests = %+v", reqs)
	}
	req := reqs[0]
	if got := req.Header.Get("x-api-key"); got != "ant-key" {
		t.Fatalf("x-api-key = %q", got)
	}
	if got := req.Header.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("anthropic-version = %q", got)
	}
	body := decodeProviderBody(t, req.Body)
	if body["model"] != "claude-model" || body["max_tokens"] != float64(5) {
		t.Fatalf("body = %v", body)
	}
}

// 非 2xx：AI SDK 从 provider 错误体里取 error.message 作为 error 字段。
func TestConnectionTestProviderError(t *testing.T) {
	h := newHarness(t)
	h.setProvider(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}`))
	})
	h.seedAIConfig("openai-compatible", h.provider.URL, "bad-key", "m", nil, nil, 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"ok":    false,
		"error": "Incorrect API key provided",
	})
}

// 连接失败（无监听端口）也只改变 {ok, error} —— 200。
func TestConnectionTestTransportError(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai-compatible", "http://127.0.0.1:1", "k", "m", nil, nil, 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	if body["ok"] != false {
		t.Fatalf("ok = %v", body["ok"])
	}
	if msg, _ := body["error"].(string); msg == "" {
		t.Fatalf("error = %v, want a message", body["error"])
	}
}

func TestConnectionTestDBFailure(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodPost, "/api/settings/ai/test", "", testPassword)
	h.assertError(rec, http.StatusInternalServerError, "Connection test failed", "TEST_ERROR")
}

// decodeProviderBody 解出出站请求 body（仅测试断言用）。
func decodeProviderBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("decode provider body %q: %v", raw, err)
	}
	return body
}
