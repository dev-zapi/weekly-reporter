// Package respond 是 /api 域路由共用的 JSON 响应写法。
//
// 单独成包的理由只有一个：`{error, code}` 与 `[]` 而不是 `null` 这两条是冻结
// 契约（蓝图 §2.1），B1 的 auth 与 audit 两个域都要用，放在任一域名下会让另一个
// 域为一行代码反向依赖。
package respond

import (
	"encoding/json"
	"log"
	"net/http"
)

// ErrorBody 是 `/api` 业务错误的统一形状；code 为空时序列化结果与鉴权失败的
// `{error:"Unauthorized"}` 同形。
type ErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// JSON 写一个 JSON 响应。序列化失败属于编程错误（响应体只有简单结构体），
// 此时回 500 而不是把半个 body 写出去。
func JSON(w http.ResponseWriter, status int, body any) {
	payload, err := json.Marshal(body)
	if err != nil {
		log.Printf("api: marshal response: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"Internal"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// Error 写一个带 code 的业务错误。
func Error(w http.ResponseWriter, status int, message, code string) {
	JSON(w, status, ErrorBody{Error: message, Code: code})
}
