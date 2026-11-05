package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// PAT（Personal Access Token）服务端逻辑，照 src/lib/auth/pat.ts 移植。
//
// 与 guard 的分工：guard 只读「这个 token 是谁、能不能用」，本文件负责签发、
// 列表、吊销——即 /api/auth/pats 这一族的写路径。
const (
	// TokenPrefix 是明文 token 的固定前缀。
	TokenPrefix = "wrp_"
	// tokenRandomLength 是 base62 随机段长度（32）。
	tokenRandomLength = 32
	// DisplayPrefixLength 是 prefix 列存的明文前 8 位（如 `wrp_a1b2`），
	// 只为 UI 辨识，不可用于校验。
	DisplayPrefixLength = 8
	// base62Alphabet 与 src/lib/auth/random.ts 逐字符一致：取模映射，
	// 因此 Go 与 TS 生成的 token 在分布上完全相同（含同样的取模偏差）。
	base62Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
)

// RandomBase62 返回 n 位 base62 随机串（CSPRNG）。
func RandomBase62(n int) string {
	out := make([]byte, n)
	_, _ = rand.Read(out) // crypto/rand.Read 从不返回错误（Go 1.24+）
	for i := range out {
		out[i] = base62Alphabet[int(out[i])%len(base62Alphabet)]
	}
	return string(out)
}

// GenerateToken 生成明文 PAT：`wrp_` + 32 位 base62。
func GenerateToken() string {
	return TokenPrefix + RandomBase62(tokenRandomLength)
}

// TokenDisplayPrefix 复刻 TS 的 `token.slice(0, 8)`：短于 8 位时原样返回
// （TS 切片越界不报错，Go 直接切会 panic）。
func TokenDisplayPrefix(token string) string {
	if len(token) < DisplayPrefixLength {
		return token
	}
	return token[:DisplayPrefixLength]
}

// CreatedPAT 是创建结果。明文 Token 只在创建响应里出现这一次，之后库里只有哈希。
type CreatedPAT struct {
	ID        int64
	Name      string
	Token     string
	CreatedAt int64
}

// CreatePAT 签发一个 PAT：只存 SHA-256 哈希 + 明文前 8 位前缀。
func CreatePAT(ctx context.Context, q *db.Queries, name string, expiresAtMillis *int64) (CreatedPAT, error) {
	token := GenerateToken()
	row, err := q.InsertAPIToken(ctx, db.InsertAPITokenParams{
		Name:       name,
		TokenHash:  HashToken(token),
		Prefix:     TokenDisplayPrefix(token),
		CreatedAt:  time.Now().UnixMilli(),
		LastUsedAt: nil,
		ExpiresAt:  expiresAtMillis,
		RevokedAt:  nil,
	})
	if err != nil {
		return CreatedPAT{}, err
	}
	return CreatedPAT{ID: row.ID, Name: row.Name, Token: token, CreatedAt: row.CreatedAt}, nil
}

// FindPATByToken 按明文 token 查行；查不到返回 ErrPATNotFound。
func FindPATByToken(ctx context.Context, q *db.Queries, token string) (db.ApiToken, error) {
	row, err := q.FindAPITokenByHash(ctx, HashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return db.ApiToken{}, ErrPATNotFound
	}
	return row, err
}

// ListPATs 列出全部 PAT 元数据（不含 token_hash、不含明文），newest first。
// 排序键 createdAt desc, id desc：同一毫秒创建的多个 PAT 仍按创建顺序倒序。
func ListPATs(ctx context.Context, q *db.Queries) ([]db.ListAPITokensRow, error) {
	return q.ListAPITokens(ctx)
}

// RevokePAT 置 revoked_at，不删行（保留审计可追溯性）。
// 已吊销的再吊销是 no-op（条件带 revoked_at IS NULL），返回 false 且时间戳不变。
func RevokePAT(ctx context.Context, q *db.Queries, id int64) (bool, error) {
	rows, err := q.RevokeAPIToken(ctx, db.RevokeAPITokenParams{
		RevokedAt: ptr(time.Now().UnixMilli()),
		ID:        id,
	})
	if err != nil {
		return false, err
	}
	return rows > 0, nil
}

// TouchPAT 更新 last_used_at。
func TouchPAT(ctx context.Context, q *db.Queries, id int64, atMillis int64) error {
	_, err := q.TouchAPIToken(ctx, db.TouchAPITokenParams{LastUsedAt: &atMillis, ID: id})
	return err
}

// PATRevoked 判断是否已吊销。
func PATRevoked(revokedAtMillis *int64) bool { return revokedAtMillis != nil }

// PATExpired 判断是否已过期；nil 表示永不过期。
func PATExpired(expiresAtMillis *int64, nowMillis int64) bool {
	return expiresAtMillis != nil && *expiresAtMillis <= nowMillis
}

func ptr[T any](v T) *T { return &v }
