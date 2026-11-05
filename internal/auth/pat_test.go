package auth

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// 本文件是 src/lib/auth/pat.test.ts 的 Go 同用例集（ADR-0029：server-only 模块
// 的单测跟着代码走）。与 guard_test.go 的分工：那边用 fakeStore 覆盖鉴权分支，
// 这边用真实 SQLite 覆盖签发 / 查找 / 吊销 / 列表的数据语义——用真库才能钉住
// 「只存哈希」「吊销不删行」「二次吊销不改时间戳」这些只有 SQL 才能证明的断言。

var goTokenPattern = regexp.MustCompile(`^wrp_[A-Za-z0-9]{32}$`)

func newQueries(t *testing.T) *db.Queries {
	t.Helper()
	return db.New(dbtest.New(t))
}

func TestGenerateTokenFormat(t *testing.T) {
	token := GenerateToken()

	if !goTokenPattern.MatchString(token) {
		t.Fatalf("token = %q, want wrp_ + 32 base62 chars", token)
	}
}

func TestGenerateTokenIsUniquePerCall(t *testing.T) {
	seen := make(map[string]struct{}, 50)
	for i := 0; i < 50; i++ {
		token := GenerateToken()
		if _, dup := seen[token]; dup {
			t.Fatalf("duplicate token %q after %d draws", token, i)
		}
		seen[token] = struct{}{}
	}
}

func TestTokenDisplayPrefixIsFirstEightChars(t *testing.T) {
	token := GenerateToken()

	prefix := TokenDisplayPrefix(token)
	if prefix != token[:8] {
		t.Fatalf("prefix = %q, want token[:8] = %q", prefix, token[:8])
	}
	if len(prefix) != DisplayPrefixLength {
		t.Fatalf("prefix length = %d, want %d", len(prefix), DisplayPrefixLength)
	}
}

// 短 token 的切片必须返回全长而不是 panic（TS 的 slice 越界不报错）。
func TestTokenDisplayPrefixToleratesShortTokens(t *testing.T) {
	if got := TokenDisplayPrefix("wrp_a"); got != "wrp_a" {
		t.Fatalf("TokenDisplayPrefix(wrp_a) = %q, want the whole string", got)
	}
}

// 固定向量：证明 Go 的 hashToken 与 TS 的 crypto.createHash('sha256') 逐字节一致，
// 否则既有部署里已签发的 PAT 会在切换后全部失效。
func TestHashTokenMatchesTSDigest(t *testing.T) {
	const want = "1dc41aa6813c105f3004919d7fd398fb1d5946d20693e2509adfd892c649e5e0"
	if got := HashToken("wrp_example"); got != want {
		t.Fatalf("HashToken(wrp_example) = %q, want %q", got, want)
	}
}

func TestHashTokenIsLowercaseHex64(t *testing.T) {
	digest := HashToken("wrp_a")
	if len(digest) != 64 {
		t.Fatalf("digest length = %d, want 64", len(digest))
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(digest) {
		t.Fatalf("digest = %q, want lowercase hex", digest)
	}
	if HashToken("wrp_a") == HashToken("wrp_b") {
		t.Fatalf("different tokens must hash differently")
	}
}

func TestCreatePATReturnsPlaintextOnce(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	if !goTokenPattern.MatchString(created.Token) {
		t.Fatalf("token = %q", created.Token)
	}
	if created.Name != "my-agent" {
		t.Fatalf("name = %q", created.Name)
	}
	if created.CreatedAt <= 0 {
		t.Fatalf("createdAt = %d, want > 0", created.CreatedAt)
	}
}

func TestCreatePATStoresOnlyTheHash(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	rows, err := q.ListAPITokens(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}

	// 列表投影本来就不含 token_hash；用 FindAPITokenByToken 拿整行断言哈希。
	row, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if row.TokenHash != HashToken(created.Token) {
		t.Fatalf("token_hash = %q, want the SHA-256 of the plaintext", row.TokenHash)
	}
	if row.TokenHash == created.Token {
		t.Fatalf("token_hash must never be the plaintext")
	}

	// 整行序列化后不得出现明文（"库里只有哈希"的强断言）。
	encoded, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), created.Token) {
		t.Fatalf("row leaks the plaintext: %s", encoded)
	}
}

func TestCreatePATStoresDisplayPrefix(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	row, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if row.Prefix != created.Token[:8] {
		t.Fatalf("prefix = %q, want %q", row.Prefix, created.Token[:8])
	}
}

func TestCreatePATDefaultsToNeverExpiringAndNotRevoked(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	row, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if row.ExpiresAt != nil {
		t.Fatalf("expiresAt = %d, want NULL", *row.ExpiresAt)
	}
	if row.RevokedAt != nil {
		t.Fatalf("revokedAt = %d, want NULL", *row.RevokedAt)
	}
	if row.LastUsedAt != nil {
		t.Fatalf("lastUsedAt = %d, want NULL", *row.LastUsedAt)
	}
}

func TestCreatePATHonoursExplicitExpiry(t *testing.T) {
	q := newQueries(t)
	expiresAt := time.Now().UnixMilli() + 60_000

	created, err := CreatePAT(context.Background(), q, "my-agent", &expiresAt)
	if err != nil {
		t.Fatal(err)
	}

	row, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if row.ExpiresAt == nil || *row.ExpiresAt != expiresAt {
		t.Fatalf("expiresAt = %v, want %d", row.ExpiresAt, expiresAt)
	}
}

func TestListPATsNeverExposesPlaintextOrHash(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	listed, err := ListPATs(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 {
		t.Fatalf("listed = %d, want 1", len(listed))
	}
	if listed[0].Name != "my-agent" || listed[0].Prefix != created.Token[:8] {
		t.Fatalf("listed[0] = %+v", listed[0])
	}

	encoded, err := json.Marshal(listed)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), created.Token) {
		t.Fatalf("list leaks the plaintext: %s", encoded)
	}
	if strings.Contains(string(encoded), HashToken(created.Token)) {
		t.Fatalf("list leaks the token hash: %s", encoded)
	}
	if strings.Contains(string(encoded), "token_hash") {
		t.Fatalf("list exposes a token_hash key: %s", encoded)
	}
}

func TestFindPATByTokenFindsTheRow(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	found, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if found.Name != "my-agent" {
		t.Fatalf("found = %+v", found)
	}
}

func TestFindPATByTokenReturnsSentinelForUnknownToken(t *testing.T) {
	q := newQueries(t)

	if _, err := FindPATByToken(context.Background(), q, "wrp_doesnotexist"); err != ErrPATNotFound {
		t.Fatalf("err = %v, want ErrPATNotFound", err)
	}
}

func TestRevokePATKeepsTheRow(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}

	revoked, err := RevokePAT(context.Background(), q, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !revoked {
		t.Fatalf("RevokePAT = false, want true")
	}

	found, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatalf("the row must survive revocation: %v", err)
	}
	if !PATRevoked(found.RevokedAt) {
		t.Fatalf("revokedAt = %v, want a timestamp", found.RevokedAt)
	}
}

func TestRevokePATReportsFalseForMissingRow(t *testing.T) {
	q := newQueries(t)

	revoked, err := RevokePAT(context.Background(), q, 9999)
	if err != nil {
		t.Fatal(err)
	}
	if revoked {
		t.Fatalf("RevokePAT = true for a missing id")
	}
}

func TestRevokePATKeepsTheOriginalTimestamp(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RevokePAT(context.Background(), q, created.ID); err != nil {
		t.Fatal(err)
	}
	first, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	firstRevokedAt := *first.RevokedAt

	// 第二次吊销是 no-op：返回 false，时间戳不变（吊销时间就是首次吊销时间）。
	revoked, err := RevokePAT(context.Background(), q, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if revoked {
		t.Fatalf("second RevokePAT = true, want false (idempotent)")
	}
	second, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if *second.RevokedAt != firstRevokedAt {
		t.Fatalf("revokedAt = %d, want the original %d", *second.RevokedAt, firstRevokedAt)
	}
}

func TestPATExpiry(t *testing.T) {
	now := time.Now().UnixMilli()

	// 无过期时间 = 永不过期。
	if PATExpired(nil, now) {
		t.Fatalf("a PAT with no expiry must never be expired")
	}

	past := now - 1000
	if !PATExpired(&past, now) {
		t.Fatalf("a PAT whose expiry is in the past must be expired")
	}

	future := now + 60_000
	if PATExpired(&future, now) {
		t.Fatalf("a PAT whose expiry is in the future must be valid")
	}

	// 边界：TS 用 `expiresAt <= now`，等于 now 即过期。
	equal := now
	if !PATExpired(&equal, now) {
		t.Fatalf("expiry == now must count as expired (<= semantics)")
	}
}

func TestTouchPATRecordsLastUsed(t *testing.T) {
	q := newQueries(t)

	created, err := CreatePAT(context.Background(), q, "my-agent", nil)
	if err != nil {
		t.Fatal(err)
	}
	before, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if before.LastUsedAt != nil {
		t.Fatalf("lastUsedAt = %v, want NULL before touch", before.LastUsedAt)
	}

	at := time.Now().UnixMilli()
	if err := TouchPAT(context.Background(), q, created.ID, at); err != nil {
		t.Fatal(err)
	}

	after, err := FindPATByToken(context.Background(), q, created.Token)
	if err != nil {
		t.Fatal(err)
	}
	if after.LastUsedAt == nil || *after.LastUsedAt != at {
		t.Fatalf("lastUsedAt = %v, want %d", after.LastUsedAt, at)
	}
}

func TestListPATsIsNewestFirst(t *testing.T) {
	q := newQueries(t)

	// 同一毫秒创建的两行靠 id desc 兜底（TS 的 orderBy(createdAt desc, id desc)）。
	if _, err := CreatePAT(context.Background(), q, "older", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := CreatePAT(context.Background(), q, "newer", nil); err != nil {
		t.Fatal(err)
	}

	listed, err := ListPATs(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 {
		t.Fatalf("listed = %d, want 2", len(listed))
	}
	if listed[0].Name != "newer" || listed[1].Name != "older" {
		t.Fatalf("order = %q,%q, want newer,older", listed[0].Name, listed[1].Name)
	}
}
