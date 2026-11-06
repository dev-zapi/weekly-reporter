package settings

import (
	"log"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件移植 src/app/api/settings/ai/test/route.ts：读存量配置 → testConnection →
// 回 {ok, error}。route.ts 不读请求体（POST 的 body 被忽略）。

// connectionTestJSON 是 test 路由的响应形状。error 是 `result.error`：
// testConnection 成功时它是 undefined，JSON.stringify 会丢掉这个键；失败时即使
// 消息是空串也会保留这个键，所以用指针 + omitempty 表达「有/没有」而不是空串。
type connectionTestJSON struct {
	OK    bool    `json:"ok"`
	Error *string `json:"error,omitempty"`
}

func testConnectionHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		config, err := getAIConfig(r.Context(), deps.Queries)
		if err != nil {
			log.Printf("POST /api/settings/ai/test error: %v", err)
			respond.Error(w, http.StatusInternalServerError, "Connection test failed", "TEST_ERROR")
			return
		}
		if config == nil {
			respond.Error(w, http.StatusBadRequest, "AI is not configured", "AI_NOT_CONFIGURED")
			return
		}

		ok, message := testConnection(r.Context(), deps.httpDo(), providerConfig{
			Protocol: config.Protocol,
			APIURL:   config.APIURL,
			APIKey:   config.APIKey,
			Model:    config.Model,
		})
		body := connectionTestJSON{OK: ok}
		if !ok {
			body.Error = &message
		}
		respond.JSON(w, http.StatusOK, body)
	}
}
