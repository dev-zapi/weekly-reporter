package auth

import (
	"context"
	"log"
	"net/http"
	"time"
)

// 审计映射，照 src/lib/auth/audit.ts 移植。
//
// 审计的存在理由（ADR-0020）：脚本 PAT 失效 / 被吊销是 PAT 场景最常见的故障，
// 不记则排障无迹可寻；浏览器（启动密码）调用留痕没有诊断价值，不记。
const (
	outcomeSuccess      = "success"
	outcomeUnauthorized = "unauthorized"
)

// NewAuditRecord 由请求与 handler 的最终状态构造一行审计。
//
// status 必须是 handler 真正写出的状态：这就是审计在 handler 返回之后写、
// 而不是在鉴权时写的全部理由（proxy 看不到最终状态）。
func NewAuditRecord(r *http.Request, status int, patName *string, atMillis int64) AuditRecord {
	return AuditRecord{
		CreatedAtMillis: atMillis,
		PatName:         patName,
		Method:          r.Method,
		APIPath:         r.URL.Path,
		Status:          status,
		UserAgent:       optionalHeader(r, "User-Agent"),
		AgentIdentity:   optionalHeader(r, agentIdentityHeader),
		CallerCwd:       optionalHeader(r, callerCwdHeader),
		Outcome:         auditOutcome(status),
	}
}

// auditOutcome 只有 401 记 unauthorized，其余（含 5xx）都是 success。
func auditOutcome(status int) string {
	if status == http.StatusUnauthorized {
		return outcomeUnauthorized
	}
	return outcomeSuccess
}

// RecordAudit 为一次请求写审计。
//
// 只有 PAT 模式落库；密码 / 关闭模式直接返回，连 store 都不碰——与 TS 的惰性
// getDatabase 同义（浏览器调用不为了留痕去开数据库）。
// 写失败只记日志，绝不改变业务响应（ADR-0020）。
func RecordAudit(ctx context.Context, store Store, r *http.Request, status int, res Result) {
	if res.Mode != ModePAT {
		return
	}
	rec := NewAuditRecord(r, status, res.PATName, time.Now().UnixMilli())
	if err := store.WriteAudit(ctx, rec); err != nil {
		log.Printf("auth: failed to write audit record: %v", err)
	}
}
