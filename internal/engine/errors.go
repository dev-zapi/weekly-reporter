package engine

import "net/http"

// ServiceError 对应 TS 的 GenerationServiceError：{error: message, code, status}。
// 路由层把它原样映射成 HTTP 响应；其它错误在生成流里按失败收尾。
type ServiceError struct {
	Message string
	Code    string
	Status  int
}

func (e *ServiceError) Error() string { return e.Message }

func serviceError(message, code string, status int) *ServiceError {
	return &ServiceError{Message: message, Code: code, Status: status}
}

// 常用错误构造（语义逐条照 src/lib/generation/{stream,service}.ts）。
func errSessionNotFound() *ServiceError {
	return serviceError("生成会话不存在", "SESSION_NOT_FOUND", http.StatusNotFound)
}

func errSourceRevisionConflict(message string) *ServiceError {
	return serviceError(message, "SOURCE_REVISION_CONFLICT", http.StatusConflict)
}
