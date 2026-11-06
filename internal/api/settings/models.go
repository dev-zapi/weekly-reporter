package settings

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/app/api/settings/ai/models/route.ts 的 GET/POST 两条探测路由。
//
// 成功路径都会把结果写进 ai_config.model_list_cache（drizzle json mode → TEXT），
// 失败路径保留 route.ts 的形状：GET 回 200 + {models: 缓存, supported:true,
// cached, error}；POST 回 200 + {models: [], supported:true, error}。

const anthropicDiscoveryMessage = "The Anthropic protocol does not support automatic model discovery; enter a model name manually"

// modelsSuccessJSON 是 GET /models 的成功响应（cachedAt 是 new Date()）。
type modelsSuccessJSON struct {
	Models    []any  `json:"models"`
	Supported bool   `json:"supported"`
	CachedAt  string `json:"cachedAt"`
}

// modelsFallbackJSON 是 GET /models 的 catch 分支：models 取库里的缓存。
type modelsFallbackJSON struct {
	Models    json.RawMessage `json:"models"`
	Supported bool            `json:"supported"`
	Cached    bool            `json:"cached"`
	Error     string          `json:"error"`
}

// modelsProbeJSON 是 POST /models 的成功响应。
type modelsProbeJSON struct {
	Models    []any `json:"models"`
	Supported bool  `json:"supported"`
}

// modelsProbeErrorJSON 是 POST /models 的 catch 分支。
type modelsProbeErrorJSON struct {
	Models    []any  `json:"models"`
	Supported bool   `json:"supported"`
	Error     string `json:"error"`
}

func listModelsHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		config, err := getAIConfig(r.Context(), deps.Queries)
		if err != nil {
			writeModelsFallback(w, r, deps, err)
			return
		}
		if config == nil {
			respond.Error(w, http.StatusBadRequest, "AI is not configured", "AI_NOT_CONFIGURED")
			return
		}
		if config.Protocol == "anthropic" {
			respond.JSON(w, http.StatusOK, struct {
				Models    []any  `json:"models"`
				Supported bool   `json:"supported"`
				Message   string `json:"message"`
			}{Models: []any{}, Supported: false, Message: anthropicDiscoveryMessage})
			return
		}

		models, err := fetchModelList(r.Context(), deps.httpDo(), providerConfig{
			Protocol: config.Protocol,
			APIURL:   config.APIURL,
			APIKey:   config.APIKey,
		})
		if err != nil {
			writeModelsFallback(w, r, deps, err)
			return
		}
		if err := updateModelListCache(r.Context(), deps.Queries, models); err != nil {
			writeModelsFallback(w, r, deps, err)
			return
		}

		respond.JSON(w, http.StatusOK, modelsSuccessJSON{
			Models:    models,
			Supported: true,
			CachedAt:  jsdate.ISOString(time.Now().UnixMilli()),
		})
	}
}

// writeModelsFallback 复刻 GET /models 的 catch：重新读一次配置取缓存。
//
// route.ts 的 catch 里没有第二层 try；若这次读取也失败，异常会越过 handler 交给
// Next 的默认 500（body 不是本路由的 JSON）。这里保留 status 500，body 用统一的
// 通用错误体，因为该分支不在任何冻结的响应契约里。
func writeModelsFallback(w http.ResponseWriter, r *http.Request, deps Deps, cause error) {
	log.Printf("GET /api/settings/ai/models error: %v", cause)

	config, err := getAIConfig(r.Context(), deps.Queries)
	if err != nil {
		log.Printf("GET /api/settings/ai/models fallback read error: %v", err)
		respond.JSON(w, http.StatusInternalServerError, respond.ErrorBody{Error: "Internal Server Error"})
		return
	}

	cached := json.RawMessage("[]")
	if config != nil {
		cached = config.ModelListCache
	}
	// `config?.modelListCache ?? []`：NULL（解析成 JSON null）回落到空数组。
	if string(cached) == "null" {
		cached = json.RawMessage("[]")
	}
	respond.JSON(w, http.StatusOK, modelsFallbackJSON{
		Models:    cached,
		Supported: true,
		Cached:    cacheLength(cached),
		Error:     cause.Error(),
	})
}

// updateModelListCache 复刻 config.ts 的 updateModelListCache：没有配置行时
// 直接返回；否则把 JSON.stringify(models) 与 now 写进缓存列。写路径是手写原生
// SQL（model_list_cache 必须是 TEXT，见 db/ai_config_native.go）。
func updateModelListCache(ctx context.Context, queries *db.Queries, models []any) error {
	existing, err := getAIConfig(ctx, queries)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	// models 一定是数组（truthy），所以 cachedAt 恒为 now。
	encoded, err := json.Marshal(models)
	if err != nil {
		return err
	}
	modelsJSON := string(encoded)
	now := time.Now().Unix()
	return queries.UpdateAIConfigModelListForSettings(ctx, existing.ID, &modelsJSON, &now, now)
}

func probeModelsHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			respondProbeError(w, err)
			return
		}
		// `const { protocol, apiUrl, apiKey } = body`：null 解构抛 TypeError，
		// 数组/标量解构得到 undefined（随后 400）。
		if body == nil {
			respondProbeError(w, errors.New("Cannot destructure property 'protocol' of 'body' as it is null."))
			return
		}
		fields := bodyFields(body)

		if !jsTruthy(fields["apiUrl"]) || !jsTruthy(fields["apiKey"]) {
			respond.Error(w, http.StatusBadRequest, "Enter an API URL and API key first", "INVALID_INPUT")
			return
		}
		if protocol, ok := fields["protocol"].(string); ok && protocol == "anthropic" {
			respond.JSON(w, http.StatusOK, struct {
				Models    []any  `json:"models"`
				Supported bool   `json:"supported"`
				Message   string `json:"message"`
			}{Models: []any{}, Supported: false, Message: anthropicDiscoveryMessage})
			return
		}

		apiURL, ok := fields["apiUrl"].(string)
		if !ok {
			// `config.apiUrl.replace(...)` 在 JS 里对非字符串抛 TypeError。
			respondProbeError(w, errors.New("config.apiUrl.replace is not a function"))
			return
		}
		// `Authorization: \`Bearer ${apiKey}\`` 走模板字符串 → String(apiKey)。
		apiKey := jsStringValue(fields["apiKey"])

		// `tempConfig.protocol = (protocol as AIProtocol) ?? 'openai'`：fetchModelList
		// 只对 anthropic 短路（上面已处理），其余协议走同一个 /models 探测。
		probeProtocol := "openai"
		if raw, present := fields["protocol"]; present && raw != nil {
			probeProtocol = jsStringValue(raw)
		}
		models, err := fetchModelList(r.Context(), deps.httpDo(), providerConfig{
			Protocol: probeProtocol,
			APIURL:   apiURL,
			APIKey:   apiKey,
		})
		if err != nil {
			respondProbeError(w, err)
			return
		}

		existing, err := getAIConfig(r.Context(), deps.Queries)
		if err != nil {
			respondProbeError(w, err)
			return
		}
		// `existingConfig.apiUrl === apiUrl` 是严格字符串相等：只有探测的 URL
		// 与存量配置一致时才写缓存。
		if existing != nil && existing.APIURL == apiURL {
			if err := updateModelListCache(r.Context(), deps.Queries, models); err != nil {
				respondProbeError(w, err)
				return
			}
		}

		respond.JSON(w, http.StatusOK, modelsProbeJSON{Models: models, Supported: true})
	}
}

// respondProbeError 复刻 POST /models 的 catch：200 + 空列表 + error 文本。
func respondProbeError(w http.ResponseWriter, cause error) {
	log.Printf("POST /api/settings/ai/models error: %v", cause)
	respond.JSON(w, http.StatusOK, modelsProbeErrorJSON{
		Models:    []any{},
		Supported: true,
		Error:     cause.Error(),
	})
}
