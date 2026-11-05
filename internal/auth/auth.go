// Package auth 复刻 ADR-0020 的鉴权语义：启动密码 + PAT 双模式、失败/成功审计。
// trace 响应头由外层 trace 中间件统一负责，本包不碰。
//
// 判定顺序严格照 src/lib/auth/guard.ts：
//
//	总开关 → Bearer 头形态 → 启动密码 → PAT（未知 / 吊销 / 过期 / 有效）
//
// 审计只覆盖 PAT 面：无头与密码模式都不落库——脚本 PAT 失效是最常见故障，
// 而浏览器调用留痕没有诊断价值（ADR-0020）。
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

const bearerPrefix = "Bearer "

// ErrPATNotFound 表示 token 哈希不在库里。仓储层把它与真实 DB 错误区分开：
// 前者要审计（pat_name 为空），后者是运维故障。
var ErrPATNotFound = errors.New("auth: pat not found")

// PAT 是鉴权所需的最小 PAT 视图。时间列沿用数据库单位（Unix 毫秒）——
// api_tokens 的四个时间列是裸 integer + Date.now()（研究文档 §1.2），
// 这里不做秒/毫秒换算，避免在鉴权关口引入 1000 倍错误。
type PAT struct {
	ID              int64
	Name            string
	ExpiresAtMillis *int64
	RevokedAtMillis *int64
}

func (p PAT) revoked() bool { return p.RevokedAtMillis != nil }

func (p PAT) expired(nowMillis int64) bool {
	return p.ExpiresAtMillis != nil && *p.ExpiresAtMillis <= nowMillis
}

// AuditRecord 与 api_audit_log 一一对应。
type AuditRecord struct {
	CreatedAtMillis int64
	PatName         *string
	Method          string
	APIPath         string
	Status          int
	UserAgent       *string
	AgentIdentity   *string
	CallerCwd       *string
	Outcome         string
}

// Store 是中间件依赖的全部数据面。收成接口而不是直接吃 *db.Queries：
// guard 单测无需数据库即可覆盖全部分支，生产实现只是 sqlc 生成代码的薄适配。
type Store interface {
	FindPAT(ctx context.Context, tokenHash string) (PAT, error)
	TouchPAT(ctx context.Context, id int64, atMillis int64) error
	WriteAudit(ctx context.Context, rec AuditRecord) error
}

// Options 配置中间件。PasswordPath 由 serve 从 XDG_CONFIG_HOME 算出后传入，
// 本包不自读环境变量：env 的语义与读取顺序都留在 cmd/wr 一处。
type Options struct {
	// Disabled 对应 WR_AUTH_DISABLED=1：放行、不读 DB、不审计。
	Disabled bool
	// PasswordPath 是 auth.json 的绝对路径；缺失/损坏一律按「没有密码」处理。
	PasswordPath string
	Store        Store
}

// 调用方自报身份头：脚本在请求上附带，仅作归因线索、不作安全依据。
const (
	agentIdentityHeader = "X-Weekly-Reporter-Agent"
	callerCwdHeader     = "X-Weekly-Reporter-Cwd"
)

// timingSafeEqualString 双侧 SHA-256 后常量时间比较：长度不等也不泄漏长度侧信道。
func timingSafeEqualString(a, b string) bool {
	hashA := sha256.Sum256([]byte(a))
	hashB := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(hashA[:], hashB[:]) == 1
}

// HashToken 复刻 src/lib/auth/pat.ts 的 hashToken：SHA-256 十六进制小写。
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func extractBearerToken(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, bearerPrefix) {
		return ""
	}
	return strings.TrimSpace(header[len(bearerPrefix):])
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
}

// Middleware 同时完成鉴权、失败审计与成功审计。
//
// 为什么一个中间件而不是两个：Go 的外层中间件读不到内层写入的 context 值，
// 而审计行必须同时知道「是哪个 PAT」与「handler 最终返回的 status」。这与 Next 的
// withAuth HOF 同构：包住 handler，返回后写审计。
func Middleware(opts Options) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			if opts.Disabled {
				next.ServeHTTP(w, r)
				return
			}

			token := extractBearerToken(r)
			if token == "" {
				// 无头 / 非 Bearer / 空 token：401 但不审计（认不出是哪个 PAT）。
				writeUnauthorized(w)
				return
			}

			if password := ReadStartupPassword(opts.PasswordPath); password != "" &&
				timingSafeEqualString(password, token) {
				next.ServeHTTP(w, r)
				return
			}

			nowMillis := time.Now().UnixMilli()
			pat, err := opts.Store.FindPAT(ctx, HashToken(token))
			switch {
			case errors.Is(err, ErrPATNotFound):
				audit(ctx, opts.Store, r, http.StatusUnauthorized, nil)
				writeUnauthorized(w)
				return
			case err != nil:
				// 数据库故障是运维错误、不是认证结论：仍按 401 拒绝，但记日志便于排障。
				log.Printf("auth: PAT lookup failed: %v", err)
				writeUnauthorized(w)
				return
			}

			if pat.revoked() || pat.expired(nowMillis) {
				name := pat.Name
				audit(ctx, opts.Store, r, http.StatusUnauthorized, &name)
				writeUnauthorized(w)
				return
			}

			if err := opts.Store.TouchPAT(ctx, pat.ID, nowMillis); err != nil {
				log.Printf("auth: touching PAT %d failed: %v", pat.ID, err)
			}

			// 审计要记录 handler 的最终 status，所以必须包一层响应写入器。用 chi 的
			// WrapResponseWriter 而不是自写结构体：它保留 Flusher / Hijacker 等可选
			// 接口，否则 B6 的流式生成会卡死（研究文档 §3.3）。
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)

			name := pat.Name
			audit(ctx, opts.Store, r, ww.Status(), &name)
		})
	}
}

// audit 写一行审计；失败只记日志，绝不改变业务响应（ADR-0020）。
func audit(ctx context.Context, store Store, r *http.Request, status int, patName *string) {
	outcome := "success"
	if status == http.StatusUnauthorized {
		outcome = "unauthorized"
	}
	rec := AuditRecord{
		CreatedAtMillis: time.Now().UnixMilli(),
		PatName:         patName,
		Method:          r.Method,
		APIPath:         r.URL.Path,
		Status:          status,
		UserAgent:       optionalHeader(r, "User-Agent"),
		AgentIdentity:   optionalHeader(r, agentIdentityHeader),
		CallerCwd:       optionalHeader(r, callerCwdHeader),
		Outcome:         outcome,
	}
	if err := store.WriteAudit(ctx, rec); err != nil {
		log.Printf("auth: failed to write audit record: %v", err)
	}
}

func optionalHeader(r *http.Request, name string) *string {
	if v := r.Header.Get(name); v != "" {
		return &v
	}
	return nil
}

// QueriesStore 把 sqlc 生成的查询集适配成 Store。
type QueriesStore struct {
	Queries *db.Queries
}

// FindPAT 按 token 哈希查 PAT；查不到返回哨兵 ErrPATNotFound。
func (s QueriesStore) FindPAT(ctx context.Context, tokenHash string) (PAT, error) {
	row, err := s.Queries.FindAPITokenByHash(ctx, tokenHash)
	if errors.Is(err, sql.ErrNoRows) {
		return PAT{}, ErrPATNotFound
	}
	if err != nil {
		return PAT{}, err
	}
	return PAT{
		ID:              row.ID,
		Name:            row.Name,
		ExpiresAtMillis: row.ExpiresAt,
		RevokedAtMillis: row.RevokedAt,
	}, nil
}

func (s QueriesStore) TouchPAT(ctx context.Context, id int64, atMillis int64) error {
	_, err := s.Queries.TouchAPIToken(ctx, db.TouchAPITokenParams{
		LastUsedAt: &atMillis,
		ID:         id,
	})
	return err
}

func (s QueriesStore) WriteAudit(ctx context.Context, rec AuditRecord) error {
	return s.Queries.InsertAuditLog(ctx, db.InsertAuditLogParams{
		CreatedAt:     rec.CreatedAtMillis,
		PatName:       rec.PatName,
		Method:        rec.Method,
		ApiPath:       rec.APIPath,
		Status:        int64(rec.Status),
		UserAgent:     rec.UserAgent,
		AgentIdentity: rec.AgentIdentity,
		CallerCwd:     rec.CallerCwd,
		Outcome:       rec.Outcome,
	})
}

// AuthConfig 镜像 src/lib/auth/password.ts 的 AuthConfig：明文 password 与机器级
// 凭据同文件。Go 侧只读 password；重写文件时必须保留 machine 字段。
type AuthConfig struct {
	Password string             `json:"password,omitempty"`
	Machine  *MachineCredential `json:"machine,omitempty"`
}

// MachineCredential 是同一文件里的机器级凭据。
type MachineCredential struct {
	BaseURL string `json:"baseUrl,omitempty"`
	PAT     string `json:"pat,omitempty"`
}

// ReadAuthConfig 读 auth.json；文件缺失 / 损坏 / 读失败都当作「没有配置」，绝不抛出——
// 认证侧必须容忍密码文件缺失（返回 401 而不是 500）。
func ReadAuthConfig(path string) (AuthConfig, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return AuthConfig{}, false
	}
	var cfg AuthConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return AuthConfig{}, false
	}
	return cfg, true
}

// ReadStartupPassword 读当前启动密码；缺失 / 损坏 / 空值返回空串。
func ReadStartupPassword(path string) string {
	cfg, ok := ReadAuthConfig(path)
	if !ok {
		return ""
	}
	return cfg.Password
}
