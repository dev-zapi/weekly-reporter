// Package jsjson 复刻 `await request.json()` 的可观测语义：读整个请求体，再按
// JSON.parse 的规则解析成 JS 值（数字统一是 float64）。
//
// 单独成包的理由与 respond / jsstr 一致：B4 的三张票在各自包里各写了一份
// decodeJSON / decodeJSONBody，语义完全一致；此后它也是其它域的统一入口。
package jsjson

import (
	"encoding/json"
	"io"
	"net/http"
)

// DecodeBody 复刻 `await request.json()`。
// json.Unmarshal 与 JSON.parse 一样拒绝尾随垃圾，且把数字折成 float64。
func DecodeBody(r *http.Request) (any, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}
