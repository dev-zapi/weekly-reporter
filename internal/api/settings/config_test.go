package settings_test

import (
	"net/http"
	"testing"
)

// 本文件是 src/app/api/settings/ai/route.ts 的 Go 同用例集（ADR-0029）：
// GET 的两条配置读取分支、PUT 的创建/复用/校验分支、DELETE，以及各 catch 的
// `{error, code}` 形状。路由本身没有现存 route.test，用例集按票面新写。

func TestGetAISettingsUnconfigured(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{"configured": false})
}

func TestGetAISettingsConfigured(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai-compatible", "https://api.example.com/v1", "secret-key", "gpt-4o-mini", nil, nil, 1_700_000_000, 1_700_000_100)

	rec := h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	// modelListCache / modelListCachedAt 是 drizzle json/timestamp mode：NULL 在
	// 响应里是 null，且两个键都必须存在。
	assertExactJSON(t, rec, map[string]any{
		"configured":        true,
		"protocol":          "openai-compatible",
		"apiUrl":            "https://api.example.com/v1",
		"apiKeyConfigured":  true,
		"model":             "gpt-4o-mini",
		"modelListCache":    nil,
		"modelListCachedAt": nil,
	})
}

func TestGetAISettingsReturnsCachedModelListAsJSON(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai", "https://api.example.com/v1", "k", "m", strPtr(`["z","a"]`), int64Ptr(1_700_000_000), 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeObject(t, rec)
	cache, ok := body["modelListCache"].([]any)
	if !ok || len(cache) != 2 || cache[0] != "z" || cache[1] != "a" {
		t.Fatalf("modelListCache = %v", body["modelListCache"])
	}
	// drizzle timestamp mode → Date → JSON.stringify → toISOString。
	if body["modelListCachedAt"] != "2023-11-14T22:13:20.000Z" {
		t.Fatalf("modelListCachedAt = %v", body["modelListCachedAt"])
	}
}

// apiKey 为空串时 !!apiKey 为 false（api_key 是 NOT NULL，空串在存量库里合法）。
func TestGetAISettingsEmptyAPIKeyIsNotConfigured(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("anthropic", "https://api.anthropic.com", "", "claude", nil, nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	body := decodeObject(t, rec)
	if body["apiKeyConfigured"] != false {
		t.Fatalf("apiKeyConfigured = %v, want false", body["apiKeyConfigured"])
	}
}

func TestGetAISettingsDBFailure(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	h.assertError(rec, http.StatusInternalServerError, "Failed to load AI settings", "FETCH_ERROR")
}

// drizzle 的 json mode 在读取时会 JSON.parse：库里的缓存列不是合法 JSON 时整条
// 查询抛错，落到 GET 的 catch（500 FETCH_ERROR）。
func TestGetAISettingsInvalidCachedJSON(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai", "https://api.example.com/v1", "k", "m", strPtr(`{not json`), nil, 1, 2)

	rec := h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	h.assertError(rec, http.StatusInternalServerError, "Failed to load AI settings", "FETCH_ERROR")
}

func TestPutAISettingsCreatesConfig(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPut, "/api/settings/ai",
		`{"protocol":"anthropic","apiUrl":"https://api.anthropic.com","apiKey":"ant-key","model":"claude-sonnet"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"configured":       true,
		"protocol":         "anthropic",
		"apiUrl":           "https://api.anthropic.com",
		"apiKeyConfigured": true,
		"model":            "claude-sonnet",
	})

	row := h.aiConfig()
	if row == nil {
		t.Fatal("ai_config row missing")
	}
	if row.Protocol != "anthropic" || row.APIURL != "https://api.anthropic.com" ||
		row.APIKey != "ant-key" || row.Model != "claude-sonnet" {
		t.Fatalf("row = %+v", row)
	}
	// drizzle 插入不写缓存列；createdAt/updatedAt 都是同一个 now。
	if row.CacheType != "null" || row.CacheCachedAt != nil {
		t.Fatalf("cache = %q/%v, want NULL", row.CacheType, row.CacheCachedAt)
	}
	if row.CreatedAt != row.UpdatedAt {
		t.Fatalf("createdAt %d != updatedAt %d", row.CreatedAt, row.UpdatedAt)
	}
}

// protocol 缺省时存 openai-compatible（saveAIConfig 的 `?? 'openai-compatible'`）。
func TestPutAISettingsDefaultsProtocol(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPut, "/api/settings/ai",
		`{"apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if row := h.aiConfig(); row == nil || row.Protocol != "openai-compatible" {
		t.Fatalf("row = %+v", row)
	}
}

// 已配置时只改 apiUrl：apiKey / model 空缺省 → 复用存量；缓存列不被重写。
func TestPutAISettingsReusesStoredKeyModelAndCache(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai", "https://old.example.com/v1", "stored-key", "stored-model",
		strPtr(`["cached"]`), int64Ptr(1_700_000_000), 1_700_000_000, 1_000)

	rec := h.do(http.MethodPut, "/api/settings/ai",
		`{"apiUrl":"https://new.example.com/v1","apiKey":"","model":null}`, testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{
		"configured":       true,
		"protocol":         "openai-compatible",
		"apiUrl":           "https://new.example.com/v1",
		"apiKeyConfigured": true,
		"model":            "stored-model",
	})

	row := h.aiConfig()
	if row.APIKey != "stored-key" || row.Model != "stored-model" || row.APIURL != "https://new.example.com/v1" {
		t.Fatalf("row = %+v", row)
	}
	// update 只写 protocol/api_url/api_key/model/updated_at：缓存列与 created_at 不动。
	if row.CacheType != "text" || row.Cache != `["cached"]` || row.CacheCachedAt == nil || *row.CacheCachedAt != 1_700_000_000 {
		t.Fatalf("cache = %q/%v", row.Cache, row.CacheCachedAt)
	}
	if row.CreatedAt != 1_700_000_000 {
		t.Fatalf("createdAt = %d", row.CreatedAt)
	}
	if row.UpdatedAt <= 1_000 {
		t.Fatalf("updatedAt = %d, want a fresh timestamp", row.UpdatedAt)
	}
}

func TestPutAISettingsValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
		msg  string
	}{
		{"missing apiUrl", `{}`, "API URL is required"},
		{"empty apiUrl", `{"apiUrl":""}`, "API URL is required"},
		{"non-string apiUrl", `{"apiUrl":42}`, "API URL is required"},
		{"null apiUrl", `{"apiUrl":null}`, "API URL is required"},
		{"relative apiUrl", `{"apiUrl":"not-a-url"}`, "Invalid API URL"},
		{"scheme-only apiUrl", `{"apiUrl":"http://"}`, "Invalid API URL"},
		{"space-only apiUrl", `{"apiUrl":" "}`, "Invalid API URL"},
		{"bad port", `{"apiUrl":"http://x:99999"}`, "Invalid API URL"},
		{"malformed apiUrl", `{"apiUrl":"http://exa mple.com"}`, "Invalid API URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			rec := h.do(http.MethodPut, "/api/settings/ai", tc.body, testPassword)
			h.assertError(rec, http.StatusBadRequest, tc.msg, "INVALID_INPUT")
		})
	}

	t.Run("missing apiKey", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"apiUrl":"https://api.example.com/v1","model":"m"}`, testPassword)
		h.assertError(rec, http.StatusBadRequest, "API key is required", "INVALID_INPUT")
	})

	t.Run("missing model", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"apiUrl":"https://api.example.com/v1","apiKey":"k"}`, testPassword)
		h.assertError(rec, http.StatusBadRequest, "Model name is required", "INVALID_INPUT")
	})

	t.Run("invalid protocol", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"protocol":"gpt","apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
		h.assertError(rec, http.StatusBadRequest, "Invalid protocol", "INVALID_INPUT")
	})

	t.Run("non-string protocol", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"protocol":7,"apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
		h.assertError(rec, http.StatusBadRequest, "Invalid protocol", "INVALID_INPUT")
	})

	// 0 是 falsy，跳过白名单检查；?? 不会回落到默认值，于是 0 被 better-sqlite3
	// 绑成 REAL，TEXT affinity 落库成 "0.0"。
	t.Run("zero protocol keeps its driver value", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"protocol":0,"apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
		}
		body := decodeObject(t, rec)
		if body["protocol"] != "0.0" {
			t.Fatalf("protocol = %v, want the driver's \"0.0\"", body["protocol"])
		}
		if row := h.aiConfig(); row.Protocol != "0.0" {
			t.Fatalf("stored protocol = %q", row.Protocol)
		}
	})

	// false 也是 falsy，但 better-sqlite3 拒绑布尔 → 外层 catch → 500。
	t.Run("boolean protocol is unbindable", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"protocol":false,"apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
		h.assertError(rec, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
		if h.aiConfigCount() != 0 {
			t.Fatal("unbindable protocol must not write a row")
		}
	})

	// 空串是 falsy，跳过白名单；?? 只吞 null/undefined，所以存的是空串。
	t.Run("empty protocol stays empty", func(t *testing.T) {
		h := newHarness(t)
		rec := h.do(http.MethodPut, "/api/settings/ai",
			`{"protocol":"","apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
		}
		if body := decodeObject(t, rec); body["protocol"] != "" {
			t.Fatalf("protocol = %v, want empty string", body["protocol"])
		}
	})
}

// `await request.json()` 抛错与 body 为 null 的解构异常都落在 route.ts 外层
// catch：500 + SAVE_ERROR（不是 400）。
func TestPutAISettingsBadBody(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"malformed json", `{"apiUrl":`},
		{"trailing garbage", `{"apiUrl":"https://x.example.com"} nope`},
		{"json null", `null`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			rec := h.do(http.MethodPut, "/api/settings/ai", tc.body, testPassword)
			h.assertError(rec, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
			if h.aiConfigCount() != 0 {
				t.Fatal("bad body must not write ai_config")
			}
		})
	}
}

// 非对象 body（数组/标量）在 JS 里解构不抛错，字段全 undefined → 400。
func TestPutAISettingsNonObjectBodyIsInvalidInput(t *testing.T) {
	for _, body := range []string{`[]`, `"text"`, `5`, `true`} {
		t.Run(body, func(t *testing.T) {
			h := newHarness(t)
			rec := h.do(http.MethodPut, "/api/settings/ai", body, testPassword)
			h.assertError(rec, http.StatusBadRequest, "API URL is required", "INVALID_INPUT")
		})
	}
}

// WHATWG `new URL()` 会 trim 首尾 C0/空格并把 tab/换行从整串里删除。
func TestPutAISettingsAcceptsWHATWGURLForms(t *testing.T) {
	cases := []string{
		" https://api.example.com/v1 ",
		"https://api.example.com/v1",
		"http://localhost:8080/v1/",
		"https://例子.测试/路径",
	}
	for _, apiURL := range cases {
		t.Run(apiURL, func(t *testing.T) {
			h := newHarness(t)
			rec := h.do(http.MethodPut, "/api/settings/ai",
				`{"apiUrl":`+mustJSON(t, apiURL)+`,"apiKey":"k","model":"m"}`, testPassword)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestPutAISettingsDBFailure(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodPut, "/api/settings/ai",
		`{"apiUrl":"https://api.example.com/v1","apiKey":"k","model":"m"}`, testPassword)
	h.assertError(rec, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
}

func TestDeleteAISettingsClearsConfig(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai", "https://api.example.com/v1", "k", "m", strPtr(`["x"]`), int64Ptr(1), 1, 2)

	rec := h.do(http.MethodDelete, "/api/settings/ai", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	assertExactJSON(t, rec, map[string]any{"configured": false})
	if h.aiConfigCount() != 0 {
		t.Fatalf("ai_config rows = %d, want 0", h.aiConfigCount())
	}

	// 再 GET 回到未配置分支。
	rec = h.do(http.MethodGet, "/api/settings/ai", "", testPassword)
	assertExactJSON(t, rec, map[string]any{"configured": false})
}

// `db.delete(aiConfig)` 无 where：多行也全删。
func TestDeleteAISettingsClearsEveryRow(t *testing.T) {
	h := newHarness(t)
	h.seedAIConfig("openai", "https://a.example.com", "k1", "m1", nil, nil, 1, 2)
	h.seedAIConfig("anthropic", "https://b.example.com", "k2", "m2", nil, nil, 3, 4)

	rec := h.do(http.MethodDelete, "/api/settings/ai", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if h.aiConfigCount() != 0 {
		t.Fatalf("ai_config rows = %d, want 0", h.aiConfigCount())
	}
}

func TestDeleteAISettingsDBFailure(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.do(http.MethodDelete, "/api/settings/ai", "", testPassword)
	h.assertError(rec, http.StatusInternalServerError, "Failed to delete AI settings", "DELETE_ERROR")
}

// mustJSON 把 Go 字符串编成 JSON 字面量（测试 body 拼接用）。
func mustJSON(t *testing.T, value string) string {
	t.Helper()
	encoded, err := marshalString(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
