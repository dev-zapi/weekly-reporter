package reports

import "errors"

// jsNamedError 是带 JS Error 名字的错误：Error() 就是 TS catch 里
// `String(error)` 的输出（例如 "TypeError: Cannot read properties of null"）。
//
// route.ts 的 details 字段用 String(error)：普通 Error 实例输出
// "Error: <message>"，TypeError/SyntaxError 等子类把名字放在前面。Go 侧只有
// 普通 error，因此用一个显式包装标记「名字已经包含在消息里」，避免 500 的
// details 再叠一层 "Error: " 前缀。
type jsNamedError struct {
	name    string
	message string
}

func (e *jsNamedError) Error() string { return e.name + ": " + e.message }

func newJSTypeError(message string) error {
	return &jsNamedError{name: "TypeError", message: message}
}

// jsErrorString 复刻 `String(error)` 在报告生成路由 catch 里的可观测输出：
// 普通 Error 实例 → "Error: <message>"；jsNamedError → "<Name>: <message>"。
func jsErrorString(err error) string {
	var named *jsNamedError
	if errors.As(err, &named) {
		return named.Error()
	}
	return "Error: " + err.Error()
}
