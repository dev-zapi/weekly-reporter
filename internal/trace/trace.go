// Package trace 提供请求级 trace/span 标识与全局中间件（ADR-0022 的 Go 对应物）。
//
// 语义与 src/lib/trace/ids.ts 对齐：traceId 32 位小写 hex、spanId 16 位小写 hex、
// 均不得全 0；入站 traceId 按 traceparent → x-b3-traceid → x-trace-id 的优先级继承，
// 非法候选逐层跳过而不是拒绝请求（trace 是诊断信号，绝不成为请求失败的理由）。
package trace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"
)

const (
	headerTraceID     = "x-trace-id"
	headerSpanID      = "x-span-id"
	headerTraceParent = "traceparent"
)

var (
	traceIDPattern     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	spanIDPattern      = regexp.MustCompile(`^[0-9a-f]{16}$`)
	b3TraceIDPattern   = regexp.MustCompile(`^[0-9a-f]{16}$`)
	traceParentPattern = regexp.MustCompile(`^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)
)

const (
	zeroTraceID = "00000000000000000000000000000000"
	zeroSpanID  = "0000000000000000"
)

// Context 是单个请求的根 span。子 span 暂不引入（ADR-0022 保留到出现真实消费者）。
type Context struct {
	TraceID string
	SpanID  string
}

type contextKey struct{}

// WithContext 把 trace 上下文挂到 ctx 上，供 handler 与日志读取。
func WithContext(ctx context.Context, tc Context) context.Context {
	return context.WithValue(ctx, contextKey{}, tc)
}

// FromContext 读取当前 trace 上下文；未经过 trace 中间件时返回 false。
func FromContext(ctx context.Context) (Context, bool) {
	tc, ok := ctx.Value(contextKey{}).(Context)
	return tc, ok
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf) // crypto/rand.Read 从不返回错误（Go 1.24+）
	return hex.EncodeToString(buf)
}

// NewTraceID 生成 128-bit traceId（32 位小写 hex）。
func NewTraceID() string {
	id := randomHex(16)
	for id == zeroTraceID {
		id = randomHex(16)
	}
	return id
}

// NewSpanID 生成 64-bit spanId（16 位小写 hex）。
func NewSpanID() string {
	id := randomHex(8)
	for id == zeroSpanID {
		id = randomHex(8)
	}
	return id
}

func isValidTraceID(id string) bool {
	return traceIDPattern.MatchString(id) && id != zeroTraceID
}

func isValidSpanID(id string) bool {
	return spanIDPattern.MatchString(id) && id != zeroSpanID
}

// normalizeB3TraceID 把 Sleuth 默认的 64-bit traceId 左补 0 扩成 128-bit。
func normalizeB3TraceID(value string) (string, bool) {
	if isValidTraceID(value) {
		return value, true
	}
	if b3TraceIDPattern.MatchString(value) {
		padded := strings.Repeat("0", 16) + value
		if isValidTraceID(padded) {
			return padded, true
		}
	}
	return "", false
}

// ParseIncomingTraceID 按 traceparent → x-b3-traceid → x-trace-id 解析入站 traceId。
// ok=false 时由调用方新建；每一层非法都继续看下一层，绝不拒绝请求。
func ParseIncomingTraceID(h http.Header) (string, bool) {
	if raw := h.Get(headerTraceParent); raw != "" {
		if match := traceParentPattern.FindStringSubmatch(strings.TrimSpace(raw)); match != nil {
			version, traceID, spanID := match[1], match[2], match[3]
			// 版本 ff 是 W3C 明令非法值；其余两位 hex 版本都放过（向前兼容）。
			if version != "ff" && isValidTraceID(traceID) && isValidSpanID(spanID) {
				return traceID, true
			}
		}
	}

	if raw := strings.TrimSpace(h.Get("x-b3-traceid")); raw != "" {
		if normalized, ok := normalizeB3TraceID(raw); ok {
			return normalized, true
		}
	}

	if raw := strings.TrimSpace(h.Get(headerTraceID)); raw != "" && isValidTraceID(raw) {
		return raw, true
	}

	return "", false
}

// TraceParent 拼出响应/出站头 `00-{traceId}-{spanId}-01`（flags 恒为 sampled）。
func TraceParent(traceID, spanID string) string {
	return "00-" + traceID + "-" + spanID + "-01"
}

// Middleware 是最外层全局中间件：为每个请求建根 span 并先写响应头。
//
// 为什么先写头：Go 的 ResponseWriter 在 WriteHeader 之前都能改 header，所以这里
// 只需写一次，下游任何 401 / 404 / 500 都自动带 trace 头——Next 版里 withAuth 与
// proxy.ts 两头补头的行为由这一层统一取代。
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceID, ok := ParseIncomingTraceID(r.Header)
		if !ok {
			traceID = NewTraceID()
		}
		// 入站 traceparent 的 span 位不采纳为 parent：本进程没有上游 span 对象可指，
		// 请求仍从根 span 起（只延续 traceId）。
		tc := Context{TraceID: traceID, SpanID: NewSpanID()}

		h := w.Header()
		h.Set(headerTraceID, tc.TraceID)
		h.Set(headerSpanID, tc.SpanID)
		h.Set(headerTraceParent, TraceParent(tc.TraceID, tc.SpanID))

		next.ServeHTTP(w, r.WithContext(WithContext(r.Context(), tc)))
	})
}
