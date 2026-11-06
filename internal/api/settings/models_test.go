package settings_test

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

// 本文件是 src/app/api/settings/ai/models/route.ts 的 Go 同用例集：GET 的
// 「未配置 / anthropic / 拉取成功 / 拉取失败回退缓存」四条分支，POST 的
// 「缺参 / anthropic / 拉取成功写缓存 / 拉取失败」四条分支。
// provider 用本地 httptest 端点（票面要求的 mock provider 端点）。

const anthropicDiscoveryMessage = "The Anthropic protocol does not support automatic model discovery; enter a model name manually"

var isoMillisPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// providerModels 是 OpenAI 风格模型列表端点。
func providerModels(ids ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		type model struct {
			ID string `json:"id"`
		}
		models := make([]model, 0, len(ids))
		for _, id := range ids {
			models = append(models, model{ID: id})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
	}
}

func TestGetModelsUnconfigured(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	h.assertError(rec, http.StatusBadRequest, "AI is not configured", "AI_NOT_CONFIGURED")
}

func TestGetModelsAnthropicIsUnsupported(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("anthropic", "https://api.anthropic.com", "k", "claude", nil, nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"models":    []any{},
		"supported": false,
		"message":   anthropicDiscoveryMessage,
	})
	if reqs := h.providerRequests(); len(reqs) != 0 {
		t.Fatalf("anthropic must not probe the provider: %+v", reqs)
	}
}

func TestGetModelsFetchesSortsAndCaches(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerModels("zeta", "alpha"))
	// 尾斜杠要被 replace(/\/+$/, '') 全部剥掉。
	apiURL := h.provider.URL + "/v1///"
	h.seedAIConfig("openai-compatible", apiURL, "stored-key", "m", nil, nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	models, ok := body["models"].([]any)
	if !ok || len(models) != 2 || models[0] != "alpha" || models[1] != "zeta" {
		t.Fatalf("models = %v, want sorted [alpha zeta]", body["models"])
	}
	if body["supported"] != true {
		t.Fatalf("supported = %v", body["supported"])
	}
	cachedAt, _ := body["cachedAt"].(string)
	if !isoMillisPattern.MatchString(cachedAt) {
		t.Fatalf("cachedAt = %q, want ISO with millis", cachedAt)
	}
	if _, ok := body["cached"]; ok {
		t.Fatalf("success response must not carry cached: %s", rec.Body.String())
	}

	reqs := h.providerRequests()
	if len(reqs) != 1 {
		t.Fatalf("provider requests = %d, want 1", len(reqs))
	}
	req := reqs[0]
	if req.Method != http.MethodGet || req.Path != "/v1/models" {
		t.Fatalf("request = %s %s", req.Method, req.Path)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer stored-key" {
		t.Fatalf("Authorization = %q", got)
	}
	// withTraceHeaders：出站请求带当前请求的 traceparent / x-trace-id。
	traceID := rec.Header().Get("x-trace-id")
	if traceID == "" || req.Header.Get("x-trace-id") != traceID {
		t.Fatalf("outbound x-trace-id = %q, want %q", req.Header.Get("x-trace-id"), traceID)
	}
	if !strings.HasPrefix(req.Header.Get("traceparent"), "00-"+traceID+"-") {
		t.Fatalf("outbound traceparent = %q", req.Header.Get("traceparent"))
	}

	row := h.aiConfig()
	if row == nil {
		t.Fatal("config row missing")
	}
	// drizzle json mode 写 TEXT；JSON.stringify(["alpha","zeta"]) 是紧凑形式。
	if row.CacheType != "text" || row.Cache != `["alpha","zeta"]` {
		t.Fatalf("cache = %q (%s), want text [\"alpha\",\"zeta\"]", row.Cache, row.CacheType)
	}
	if row.CacheCachedAt == nil || *row.CacheCachedAt == 0 {
		t.Fatalf("modelListCachedAt = %v", row.CacheCachedAt)
	}
	if row.UpdatedAt != *row.CacheCachedAt {
		t.Fatalf("updated_at %d != model_list_cached_at %d", row.UpdatedAt, *row.CacheCachedAt)
	}
}

func TestGetModelsProviderFailureFallsBackToEmptyCache(t *testing.T) {
	h := newHarness(t)
	h.setProvider(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	h.seedAIConfig("openai-compatible", h.provider.URL, "k", "m", nil, nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s (route.ts 的 catch 仍是 200)", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"models":    []any{},
		"supported": true,
		"cached":    false,
		"error":     "Failed to fetch models: 500 Internal Server Error",
	})
}

func TestGetModelsProviderFailureFallsBackToCachedList(t *testing.T) {
	h := newHarness(t)
	h.setProvider(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "", http.StatusBadGateway)
	})
	h.seedAIConfig("openai-compatible", h.provider.URL, "k", "m", strPtr(`["cached-a","cached-b"]`), int64Ptr(1_700_000_000), 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	body := decodeObject(t, rec)
	models, ok := body["models"].([]any)
	if !ok || len(models) != 2 || models[0] != "cached-a" || models[1] != "cached-b" {
		t.Fatalf("models = %v", body["models"])
	}
	if body["cached"] != true || body["supported"] != true {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if body["error"] != "Failed to fetch models: 502 Bad Gateway" {
		t.Fatalf("error = %v", body["error"])
	}
}

// 模型列表响应体里的 data 不是数组 → JS 的 `data.data.map` 抛 TypeError →
// GET 的 catch 分支（200 + error）。
func TestGetModelsMalformedProviderPayload(t *testing.T) {
	h := newHarness(t)
	h.setProvider(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":"nope"}`))
	})
	h.seedAIConfig("openai-compatible", h.provider.URL, "k", "m", nil, nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	if body["error"] == "" || body["error"] == nil {
		t.Fatalf("error = %v, want a message", body["error"])
	}
}

// data.data 为 null/缺失时 `?.` + `?? []` 得到空列表，不算错误。
func TestGetModelsMissingDataIsEmptyList(t *testing.T) {
	h := newHarness(t)
	h.setProvider(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list"}`))
	})
	h.seedAIConfig("openai-compatible", h.provider.URL, "k", "m", nil, nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	if models, ok := body["models"].([]any); !ok || len(models) != 0 {
		t.Fatalf("models = %v, want []", body["models"])
	}
	if body["supported"] != true {
		t.Fatalf("supported = %v", body["supported"])
	}
	if _, hasError := body["error"]; hasError {
		t.Fatalf("missing data.data is not an error: %s", rec.Body.String())
	}
	if cachedAt, _ := body["cachedAt"].(string); !isoMillisPattern.MatchString(cachedAt) {
		t.Fatalf("cachedAt = %q", cachedAt)
	}
}

func TestPostModelsRequiresURLAndKey(t *testing.T) {
	h := newHarness(t)

	for _, body := range []string{`{}`, `{"apiUrl":"https://x.example.com"}`, `{"apiKey":"k"}`, `{"apiUrl":"","apiKey":""}`} {
		t.Run(body, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/settings/ai/models", body, testPassword)
			h.assertError(rec, http.StatusBadRequest, "Enter an API URL and API key first", "INVALID_INPUT")
		})
	}
}

func TestPostModelsAnthropicIsUnsupported(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/settings/ai/models",
		`{"protocol":"anthropic","apiUrl":"https://api.anthropic.com","apiKey":"k"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"models":    []any{},
		"supported": false,
		"message":   anthropicDiscoveryMessage,
	})
}

func TestPostModelsFetchesAndUpdatesMatchingCache(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerModels("b", "a"))
	// apiUrl 与响应比较用的是严格相等；库里存不带尾斜杠的形式。
	apiURL := h.provider.URL + "/v1"
	h.seedAIConfig("openai-compatible", apiURL, "old", "m", strPtr(`["old-cache"]`), int64Ptr(1_700_000_000), 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/models",
		`{"protocol":"openai-compatible","apiUrl":`+mustJSON(t, apiURL)+`,"apiKey":"new-key"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{"models": []any{"a", "b"}, "supported": true})

	reqs := h.providerRequests()
	if len(reqs) != 1 || reqs[0].Path != "/v1/models" || reqs[0].Header.Get("Authorization") != "Bearer new-key" {
		t.Fatalf("provider requests = %+v", reqs)
	}
	if row := h.aiConfig(); row.Cache != `["a","b"]` || *row.CacheCachedAt == 0 {
		t.Fatalf("cache = %q/%v", row.Cache, row.CacheCachedAt)
	}
}

// 存量配置的 apiUrl 与请求里的不同 → 不写缓存。
func TestPostModelsDoesNotCacheForDifferentAPIURL(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerModels("a"))
	h.seedAIConfig("openai-compatible", "https://other.example.com", "old", "m", strPtr(`["old-cache"]`), int64Ptr(1_700_000_000), 1, 2)

	rec := h.do(http.MethodPost, "/api/settings/ai/models",
		`{"protocol":"openai-compatible","apiUrl":`+mustJSON(t, h.provider.URL)+`,"apiKey":"k"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if row := h.aiConfig(); row.Cache != `["old-cache"]` || *row.CacheCachedAt != 1_700_000_000 {
		t.Fatalf("cache = %q/%v, want untouched", row.Cache, row.CacheCachedAt)
	}
}

func TestPostModelsProviderFailure(t *testing.T) {
	h := newHarness(t)
	h.setProvider(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	})

	rec := h.do(http.MethodPost, "/api/settings/ai/models",
		`{"protocol":"openai-compatible","apiUrl":`+mustJSON(t, h.provider.URL)+`,"apiKey":"k"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"models":    []any{},
		"supported": true,
		"error":     "Failed to fetch models: 401 Unauthorized",
	})
}

// `await request.json()` 抛错在 POST 里也走 catch → 200 + error 字段。
func TestPostModelsMalformedBody(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/settings/ai/models", `{"apiUrl":`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	if body["models"] == nil || body["supported"] != true {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if msg, _ := body["error"].(string); msg == "" {
		t.Fatalf("error = %v, want a message", body["error"])
	}
}

// 探测成功但写缓存前读库失败 → 落到 POST 的 catch（200 + error）。
func TestPostModelsCacheWriteFailure(t *testing.T) {
	h := newHarness(t)
	h.setProvider(providerModels("a"))
	apiURL := h.provider.URL
	// 先正常配置一行，再打断连接：fetchModelList 成功之后才读库。
	h.seedAIConfig("openai-compatible", apiURL, "k", "m", nil, nil, 1, 2)
	h.breakDB()

	rec := h.do(http.MethodPost, "/api/settings/ai/models",
		`{"protocol":"openai-compatible","apiUrl":`+mustJSON(t, apiURL)+`,"apiKey":"k"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	if body["supported"] != true {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if models, ok := body["models"].([]any); !ok || len(models) != 0 {
		t.Fatalf("models = %v, want []", body["models"])
	}
	if msg, _ := body["error"].(string); msg == "" {
		t.Fatalf("error = %v, want the cache-write failure", body["error"])
	}
}

// GET 的 catch 里那次重读配置同样失败时，route.ts 没有第二层 try，异常越过
// handler（Next 的默认 500）。这里只钉状态码——body 不在本路由的冻结契约里。
func TestGetModelsDBFailureIs500(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodGet, "/api/settings/ai/models", "", testPassword)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
}
