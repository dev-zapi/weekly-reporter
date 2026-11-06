package settings

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsdate"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件移植 src/app/api/settings/ai/route.ts 与 src/lib/ai/config.ts 的配置
// 读写路径：ai_config 是单行表（`select().from(aiConfig).limit(1)`），缓存列
// model_list_cache 是 JSON text（drizzle json mode）。
//
// 时间列是 Unix 秒（drizzle timestamp mode）；`new Date()` 在 JS 里以毫秒存
// 在内存、落库时截成秒，响应里再经 JSON.stringify 变成 .000Z 的 ISO 字符串。

// aiConfigRow 是 ai_config 一行的领域形状。
//
// ModelListCache 已经按 drizzle json mode 的语义解析过：SQL NULL 与 JSON 文本
// "null" 都是 json.RawMessage("null")，其余是紧凑化后的 JSON 值。drizzle 在
// 行映射阶段就 JSON.parse，非法 JSON 会让整条查询抛错，所以解析放在
// getAIConfig 里而不是各 handler 里。
type aiConfigRow struct {
	ID                int64
	Protocol          string
	APIURL            string
	APIKey            string
	Model             string
	ModelListCache    json.RawMessage
	ModelListCachedAt *int64
	CreatedAt         int64
	UpdatedAt         int64
}

// getAIConfig 复刻 getAIConfig：取第一行，没有则 nil。
func getAIConfig(ctx context.Context, queries *db.Queries) (*aiConfigRow, error) {
	row, err := queries.GetAIConfigForSettings(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cache, err := modelListCacheJSON(row.ModelListCache)
	if err != nil {
		return nil, err
	}
	return &aiConfigRow{
		ID:                row.ID,
		Protocol:          row.Protocol,
		APIURL:            row.ApiUrl,
		APIKey:            row.ApiKey,
		Model:             row.Model,
		ModelListCache:    cache,
		ModelListCachedAt: row.ModelListCachedAt,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
	}, nil
}

// saveAIConfig 复刻 saveAIConfig：有行则 update（只重写四个配置列 + updated_at），
// 否则 insert（created_at/updated_at 都取同一个 now）。
func saveAIConfig(ctx context.Context, queries *db.Queries, protocol, apiURL, apiKey, model string) (*aiConfigRow, error) {
	existing, err := getAIConfig(ctx, queries)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()

	if existing != nil {
		row, err := queries.UpdateAIConfigForSettings(ctx, db.UpdateAIConfigForSettingsParams{
			Protocol:  protocol,
			ApiUrl:    apiURL,
			ApiKey:    apiKey,
			Model:     model,
			UpdatedAt: now,
			ID:        existing.ID,
		})
		if err != nil {
			return nil, err
		}
		cache, err := modelListCacheJSON(row.ModelListCache)
		if err != nil {
			return nil, err
		}
		return configRowFromValues(row.ID, row.Protocol, row.ApiUrl, row.ApiKey, row.Model, cache, row.ModelListCachedAt, row.CreatedAt, row.UpdatedAt), nil
	}

	row, err := queries.InsertAIConfigForSettings(ctx, db.InsertAIConfigForSettingsParams{
		Protocol:  protocol,
		ApiUrl:    apiURL,
		ApiKey:    apiKey,
		Model:     model,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return nil, err
	}
	cache, err := modelListCacheJSON(row.ModelListCache)
	if err != nil {
		return nil, err
	}
	return configRowFromValues(row.ID, row.Protocol, row.ApiUrl, row.ApiKey, row.Model, cache, row.ModelListCachedAt, row.CreatedAt, row.UpdatedAt), nil
}

// configRowFromValues 收敛三个 sqlc 行的搬运（列集合完全相同）。
func configRowFromValues(id int64, protocol, apiURL, apiKey, model string, cache json.RawMessage, cachedAt *int64, createdAt, updatedAt int64) *aiConfigRow {
	return &aiConfigRow{
		ID:                id,
		Protocol:          protocol,
		APIURL:            apiURL,
		APIKey:            apiKey,
		Model:             model,
		ModelListCache:    cache,
		ModelListCachedAt: cachedAt,
		CreatedAt:         createdAt,
		UpdatedAt:         updatedAt,
	}
}

// clearAIConfig 复刻 `db.delete(aiConfig)`（无 where，删全部行）。
func clearAIConfig(ctx context.Context, queries *db.Queries) error {
	return queries.DeleteAIConfigForSettings(ctx)
}

// modelListCacheJSON 复刻 drizzle json mode 的读取：SQL NULL → null；文本会先
// JSON.parse 再随响应 JSON.stringify，非法 JSON 让整条查询抛错（route.ts 的
// catch → 500）。json.Compact 同时完成校验与紧凑化。
func modelListCacheJSON(raw []byte) (json.RawMessage, error) {
	if raw == nil {
		return json.RawMessage("null"), nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err
	}
	return json.RawMessage(compact.Bytes()), nil
}

// cacheLength 复刻 `cachedModels.length > 0`。列里存的是 string[]，但 drizzle 的
// json mode 会把任何合法 JSON 值都解析出来，`.length` 在字符串上是 UTF-16 长度、
// 在数组上是元素个数、在其它值上是 undefined（比较恒假）。
func cacheLength(raw json.RawMessage) bool {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	switch v := value.(type) {
	case string:
		return jsstr.UTF16Len(v) > 0
	case []any:
		return len(v) > 0
	}
	return false
}

// isoSecondsOrNull 复刻 drizzle timestamp mode 的序列化：NULL → null，
// 否则 `new Date(seconds * 1000).toISOString()`。
func isoSecondsOrNull(seconds *int64) *string {
	if seconds == nil {
		return nil
	}
	value := jsdate.ISOStringFromUnix(*seconds)
	return &value
}

// ---------------------------------------------------------------------------
// GET /api/settings/ai

type unconfiguredJSON struct {
	Configured bool `json:"configured"`
}

type configuredJSON struct {
	Configured        bool            `json:"configured"`
	Protocol          string          `json:"protocol"`
	APIURL            string          `json:"apiUrl"`
	APIKeyConfigured  bool            `json:"apiKeyConfigured"`
	Model             string          `json:"model"`
	ModelListCache    json.RawMessage `json:"modelListCache"`
	ModelListCachedAt *string         `json:"modelListCachedAt"`
}

func getConfigHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		config, err := getAIConfig(r.Context(), deps.Queries)
		if err != nil {
			log.Printf("GET /api/settings/ai error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to load AI settings", "FETCH_ERROR")
			return
		}
		if config == nil {
			respond.JSON(w, http.StatusOK, unconfiguredJSON{Configured: false})
			return
		}

		respond.JSON(w, http.StatusOK, configuredJSON{
			Configured:        true,
			Protocol:          config.Protocol,
			APIURL:            config.APIURL,
			APIKeyConfigured:  config.APIKey != "",
			Model:             config.Model,
			ModelListCache:    config.ModelListCache,
			ModelListCachedAt: isoSecondsOrNull(config.ModelListCachedAt),
		})
	}
}

// ---------------------------------------------------------------------------
// PUT /api/settings/ai

type savedConfigJSON struct {
	Configured       bool   `json:"configured"`
	Protocol         string `json:"protocol"`
	APIURL           string `json:"apiUrl"`
	APIKeyConfigured bool   `json:"apiKeyConfigured"`
	Model            string `json:"model"`
}

func putConfigHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := jsjson.DecodeBody(r)
		if err != nil {
			log.Printf("PUT /api/settings/ai error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
			return
		}
		// `const { protocol, apiUrl, apiKey, model } = body`：null 解构抛错
		//（外层 catch → 500），数组与标量解构得到 undefined（后续 400）。
		if body == nil {
			log.Printf("PUT /api/settings/ai error: cannot destructure null body")
			respond.Error(w, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
			return
		}
		fields := bodyFields(body)

		apiURLValue, apiURLIsString := fields["apiUrl"].(string)
		if !jsTruthy(fields["apiUrl"]) || !apiURLIsString {
			respond.Error(w, http.StatusBadRequest, "API URL is required", "INVALID_INPUT")
			return
		}
		if !isValidAPIURL(apiURLValue) {
			respond.Error(w, http.StatusBadRequest, "Invalid API URL", "INVALID_INPUT")
			return
		}

		existing, err := getAIConfig(r.Context(), deps.Queries)
		if err != nil {
			log.Printf("PUT /api/settings/ai error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
			return
		}

		effectiveKey, ok := effectiveString(fields, "apiKey", existing, func(c *aiConfigRow) string { return c.APIKey })
		if !ok {
			respond.Error(w, http.StatusBadRequest, "API key is required", "INVALID_INPUT")
			return
		}
		effectiveModel, ok := effectiveString(fields, "model", existing, func(c *aiConfigRow) string { return c.Model })
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Model name is required", "INVALID_INPUT")
			return
		}
		protocol, ok, storageErr := protocolValue(fields["protocol"])
		if storageErr {
			// better-sqlite3 只接受 number/string/bigint/buffer/null；布尔值在
			// drizzle 的 text 列上会抛错，被 route.ts 的外层 catch 收成 500。
			log.Printf("PUT /api/settings/ai error: unbindable protocol value")
			respond.Error(w, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
			return
		}
		if !ok {
			respond.Error(w, http.StatusBadRequest, "Invalid protocol", "INVALID_INPUT")
			return
		}

		saved, err := saveAIConfig(r.Context(), deps.Queries, protocol, apiURLValue, effectiveKey, effectiveModel)
		if err != nil {
			log.Printf("PUT /api/settings/ai error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to save AI settings", "SAVE_ERROR")
			return
		}

		respond.JSON(w, http.StatusOK, savedConfigJSON{
			Configured:       true,
			Protocol:         saved.Protocol,
			APIURL:           saved.APIURL,
			APIKeyConfigured: saved.APIKey != "",
			Model:            saved.Model,
		})
	}
}

// bodyFields 复刻宿主解构：对象取字段，数组与标量一律「没有已知字段」。
func bodyFields(body any) map[string]any {
	fields, ok := body.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return fields
}

// effectiveString 复刻
//
//	apiKey && typeof apiKey === 'string' ? apiKey : existingConfig?.apiKey
//
// 第二个返回值是「过 truthy + typeof 检查」。非字符串（含数字、对象）与空串
// 都回落到存量值。
func effectiveString(fields map[string]any, key string, existing *aiConfigRow, fromExisting func(*aiConfigRow) string) (string, bool) {
	raw, present := fields[key]
	if present && jsTruthy(raw) {
		if value, ok := raw.(string); ok {
			return value, true
		}
	}
	if existing == nil {
		return "", false
	}
	value := fromExisting(existing)
	return value, value != ""
}

// validProtocols 是 route.ts 的白名单。
var validProtocols = map[string]struct{}{
	"openai":            {},
	"openai-compatible": {},
	"anthropic":         {},
}

// protocolValue 复刻
//
//	if (protocol && !['openai','openai-compatible','anthropic'].includes(protocol)) 400
//	saveAIConfig({ protocol: protocol ?? 'openai-compatible' })
//
// 只有 null/undefined 会落到默认值；空串保持空串（?? 不是 ||）。falsy 非字符串
// （0/false）通过了 includes 检查，随后由 better-sqlite3 绑定：JS number 绑成
// REAL、TEXT affinity 落库为 "0.0"；布尔值直接抛错（第二个返回值 storageErr）。
func protocolValue(raw any) (value string, ok, storageErr bool) {
	if jsTruthy(raw) {
		s, isString := raw.(string)
		if !isString {
			return "", false, false
		}
		if _, allowed := validProtocols[s]; !allowed {
			return "", false, false
		}
		return s, true, false
	}
	switch v := raw.(type) {
	case nil:
		return "openai-compatible", true, false
	case string:
		return v, true, false
	case float64:
		// 只有 0 / -0 能到这里（非零值 truthy → 400）。SQLite 把 REAL 转 TEXT
		// 时保留一位小数。
		return strconv.FormatFloat(v, 'f', 1, 64), true, false
	case bool:
		return "", false, true
	}
	return "openai-compatible", true, false
}

// ---------------------------------------------------------------------------
// DELETE /api/settings/ai

func deleteConfigHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := clearAIConfig(r.Context(), deps.Queries); err != nil {
			log.Printf("DELETE /api/settings/ai error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Failed to delete AI settings", "DELETE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, unconfiguredJSON{Configured: false})
	}
}
