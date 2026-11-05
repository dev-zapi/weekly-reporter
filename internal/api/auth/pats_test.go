package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
)

// 本文件是 src/app/api/auth/pats/route.test.ts 的 Go 同用例集（ADR-0029）：
// GET 5 个 + POST 6 个用例逐条对应，断言面只增不减。

// patListItem 是列表响应里的一项。用 map 而不是结构体断言，是为了能验证
// "token_hash 不存在"这种"字段缺席"的负向断言。
type patListItem map[string]any

func decodePats(t *testing.T, body []byte) []patListItem {
	t.Helper()
	var resp struct {
		Pats []patListItem `json:"pats"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp.Pats
}

func findPat(t *testing.T, pats []patListItem, name string) patListItem {
	t.Helper()
	for _, p := range pats {
		if p["name"] == name {
			return p
		}
	}
	t.Fatalf("PAT %q not found in %v", name, pats)
	return nil
}

func TestListPATsReturns401WhenNotAuthenticated(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/auth/pats", "", "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestListPATsReturnsEmptyArrayWhenNoPATsExist(t *testing.T) {
	h := newHarness(t)

	// 用密码认证，避免为了"空列表"自己先造一个 PAT。
	rec := h.do(http.MethodGet, "/api/auth/pats", "", testPassword)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// 空列表必须是 []，不能是 null（前端直接读 pats.length）。
	if !strings.Contains(rec.Body.String(), `"pats":[]`) {
		t.Fatalf("body = %s, want pats:[]", rec.Body.String())
	}
}

func TestListPATsReturnsMetadataWithoutTokenHash(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	h.createPAT("pat-1", nil)
	h.createPAT("pat-2", nil)

	rec := h.do(http.MethodGet, "/api/auth/pats", "", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	pats := decodePats(t, rec.Body.Bytes())
	if len(pats) != 3 { // 含 auth-pat
		t.Fatalf("pats = %d, want 3 (%v)", len(pats), pats)
	}

	pat1 := findPat(t, pats, "pat-1")
	if pat1["id"] == nil {
		t.Fatalf("id missing: %v", pat1)
	}
	if pat1["prefix"] == nil || pat1["createdAt"] == nil {
		t.Fatalf("prefix/createdAt missing: %v", pat1)
	}

	// 安全断言：任何形态的哈希或明文都不得出现。
	for _, banned := range []string{"token_hash", "tokenHash", "token"} {
		if _, ok := pat1[banned]; ok {
			t.Fatalf("%q must not be exposed: %v", banned, pat1)
		}
	}
	if strings.Contains(rec.Body.String(), authPAT.Token) {
		t.Fatalf("response leaks a plaintext token: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), auth.HashToken(authPAT.Token)) {
		t.Fatalf("response leaks a token hash: %s", rec.Body.String())
	}
}

func TestListPATsIncludesRevokedExpiresLastUsed(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	expiresAt := int64(1700000000000)
	pat := h.createPAT("test-pat", &expiresAt)

	// 制造一个 last_used_at：直接走数据层，保持与 TS 用例"先 touch 再列表"一致。
	if err := auth.TouchPAT(context.Background(), h.conn, pat.ID, 1700000100000); err != nil {
		t.Fatal(err)
	}

	rec := h.do(http.MethodGet, "/api/auth/pats", "", authPAT.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	retrieved := findPat(t, decodePats(t, rec.Body.Bytes()), "test-pat")
	if retrieved["lastUsedAt"] == nil {
		t.Fatalf("lastUsedAt missing: %v", retrieved)
	}
	if retrieved["lastUsedAt"] != float64(1700000100000) {
		t.Fatalf("lastUsedAt = %v, want 1700000100000", retrieved["lastUsedAt"])
	}
	if retrieved["expiresAt"] != float64(expiresAt) {
		t.Fatalf("expiresAt = %v, want %d", retrieved["expiresAt"], expiresAt)
	}
	// null 必须序列化成 null（客户端用 `=== null` 判未吊销）。
	if retrieved["revokedAt"] != nil {
		t.Fatalf("revokedAt = %v, want null", retrieved["revokedAt"])
	}
	if _, ok := retrieved["revokedAt"]; !ok {
		t.Fatalf("revokedAt must be present as null: %v", retrieved)
	}
}

func TestListPATsRecordsAuditForPATMode(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	h.createPAT("pat-1", nil)

	rec := h.do(http.MethodGet, "/api/auth/pats", "", authPAT.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	if len(h.store.audits) != 1 {
		t.Fatalf("audits = %d, want 1", len(h.store.audits))
	}
	audit := h.store.audits[0]
	if audit.PatName == nil || *audit.PatName != "auth-pat" {
		t.Fatalf("audit pat name = %v", audit.PatName)
	}
	if audit.Status != http.StatusOK || audit.Outcome != "success" {
		t.Fatalf("audit = %+v", audit)
	}
}

func TestCreatePATReturns401WhenNotAuthenticated(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{"name":"test-pat"}`, "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// tokenPattern 与 TS 侧的 /^wrp_[A-Za-z0-9]{32}$/ 等价。
var tokenPattern = regexp.MustCompile(`^wrp_[A-Za-z0-9]{32}$`)

func TestCreatePATReturnsPlaintextTokenOnce(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{"name":"new-pat"}`, authPAT.Token)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}

	var created struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		Token     string `json:"token"`
		CreatedAt int64  `json:"createdAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == 0 || created.Name != "new-pat" || created.CreatedAt <= 0 {
		t.Fatalf("created = %+v", created)
	}
	if !tokenPattern.MatchString(created.Token) {
		t.Fatalf("token = %q, want wrp_ + 32 base62", created.Token)
	}
}

func TestCreatePATStoresHashNotPlaintext(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{"name":"new-pat"}`, authPAT.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}
	var created struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	row, err := auth.FindPATByToken(context.Background(), h.conn, created.Token)
	if err != nil {
		t.Fatalf("created PAT must be findable by its plaintext: %v", err)
	}
	if row.Name != "new-pat" {
		t.Fatalf("row name = %q", row.Name)
	}
	if row.TokenHash == created.Token {
		t.Fatalf("token_hash must not equal the plaintext")
	}
	if len(row.TokenHash) != 64 { // SHA-256 十六进制 = 64 字符
		t.Fatalf("token_hash length = %d, want 64", len(row.TokenHash))
	}
	if row.TokenHash != auth.HashToken(created.Token) {
		t.Fatalf("token_hash = %q, want SHA-256 of the plaintext", row.TokenHash)
	}
}

func TestCreatePATReturns400WhenNameMissing(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{}`, authPAT.Token)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body.Error, "name") {
		t.Fatalf("error = %q, want it to mention name", body.Error)
	}
	if body.Code != "INVALID_NAME" {
		t.Fatalf("code = %q, want INVALID_NAME", body.Code)
	}
}

// 票内提到的边界（trim 后为空 / 非字符串），TS 用例没写但 route.ts 明确实现。
// 这里补上，保证移植不弱化原始判定分支。
func TestCreatePATRejectsBlankAndNonStringNames(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	cases := map[string]string{
		"empty string":   `{"name":""}`,
		"spaces only":    `{"name":"   "}`,
		"null":           `{"name":null}`,
		"number":         `{"name":42}`,
		"object":         `{"name":{"a":1}}`,
		"boolean":        `{"name":true}`,
		"no name at all": `{"expiresAt":1}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/auth/pats", body, authPAT.Token)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "INVALID_NAME") {
				t.Fatalf("body = %s, want INVALID_NAME", rec.Body.String())
			}
		})
	}
}

func TestCreatePATTrimsTheName(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{"name":"  padded  "}`, authPAT.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}

	var created struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Name != "padded" {
		t.Fatalf("name = %q, want trimmed %q", created.Name, "padded")
	}
}

func TestCreatePATRespectsOptionalExpiresAt(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	const expiresAt int64 = 1700000000000

	rec := h.do(http.MethodPost, "/api/auth/pats",
		`{"name":"expiring-pat","expiresAt":1700000000000}`, authPAT.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}

	rows, err := h.conn.ListAPITokens(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, row := range rows {
		if row.Name == "expiring-pat" {
			found = true
			if row.ExpiresAt == nil || *row.ExpiresAt != expiresAt {
				t.Fatalf("expiresAt = %v, want %d", row.ExpiresAt, expiresAt)
			}
		}
	}
	if !found {
		t.Fatalf("expiring-pat not stored")
	}
}

func TestCreatePATDefaultsToNeverExpiring(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{"name":"forever"}`, authPAT.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}

	rows, err := h.conn.ListAPITokens(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Name == "forever" && row.ExpiresAt != nil {
			t.Fatalf("expiresAt = %v, want nil", *row.ExpiresAt)
		}
	}
}

func TestCreatePATRecordsAuditForCreation(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodPost, "/api/auth/pats", `{"name":"new-pat"}`, authPAT.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}

	if len(h.store.audits) != 1 {
		t.Fatalf("audits = %d, want 1", len(h.store.audits))
	}
	audit := h.store.audits[0]
	if audit.PatName == nil || *audit.PatName != "auth-pat" {
		t.Fatalf("audit pat name = %v", audit.PatName)
	}
	// 审计记录 handler 的真实 status：201，而不是 200。
	if audit.Status != http.StatusCreated || audit.Outcome != "success" {
		t.Fatalf("audit = %+v", audit)
	}
	if audit.Method != http.MethodPost || audit.APIPath != "/api/auth/pats" {
		t.Fatalf("audit identity = %+v", audit)
	}
}

// body 形态边界：TS 侧 `await request.json()` 的抛与不抛决定 500 还是 400。
// 非法 JSON / 空 body / `null` 让 request.json() 或解构抛错 → 500；
// 数组 / 字符串 / 数字 / 布尔能解构、name 为 undefined → 400 INVALID_NAME。
func TestCreatePATBodyShapeBoundaries(t *testing.T) {
	cases := map[string]struct {
		body string
		want int
		code string
	}{
		"empty body":       {"", http.StatusInternalServerError, "CREATE_ERROR"},
		"malformed json":   {`{not json`, http.StatusInternalServerError, "CREATE_ERROR"},
		"json null":        {`null`, http.StatusInternalServerError, "CREATE_ERROR"},
		"json array":       {`[{"name":"x"}]`, http.StatusBadRequest, "INVALID_NAME"},
		"json string":      {`"hello"`, http.StatusBadRequest, "INVALID_NAME"},
		"json number":      {`42`, http.StatusBadRequest, "INVALID_NAME"},
		"json boolean":     {`true`, http.StatusBadRequest, "INVALID_NAME"},
		"empty object":     {`{}`, http.StatusBadRequest, "INVALID_NAME"},
		"unknown only key": {`{"other":1}`, http.StatusBadRequest, "INVALID_NAME"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat", nil)

			rec := h.do(http.MethodPost, "/api/auth/pats", tc.body, authPAT.Token)

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("body = %s, want code %s", rec.Body.String(), tc.code)
			}
		})
	}
}
