package auth

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件是 src/app/api/auth/verify/route.test.ts 的 Go 同用例集（ADR-0029）：
// 8 个用例逐条对应，断言面只增不减。
//
// 与 TS 的差异只有夹具形态：TS 用 vi.mock 替换 getDb 与 readStartupPassword，
// Go 用真库 + 真 auth.json（同一个 schema.sql），因此断言可以用更强的
// 「数据面调用次数」表达"PAT 只判定一次"，而不是数 mock 调用。

// verifyMode 断言 200 + {ok:true, mode}。
func assertVerifyMode(t *testing.T, body []byte, want string) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	if got["ok"] != true {
		t.Fatalf("ok = %v, want true (body %s)", got["ok"], body)
	}
	if got["mode"] != want {
		t.Fatalf("mode = %v, want %q (body %s)", got["mode"], want, body)
	}
	if len(got) != 2 {
		t.Fatalf("body must carry exactly {ok, mode}: %s", body)
	}
}

func TestVerifyReturns401WithoutAuthorizationHeader(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/auth/verify", "", "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	// 错误形状冻结：只有 {error}，没有 code。
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["error"] != "Unauthorized" || len(got) != 1 {
		t.Fatalf("body = %s, want {\"error\":\"Unauthorized\"}", rec.Body.String())
	}
	if rec.Header().Get("x-trace-id") == "" {
		t.Fatalf("401 must carry trace headers: %v", rec.Header())
	}
}

func TestVerifyReturns401ForInvalidToken(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/auth/verify", "", "invalid-token")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestVerifyReturns200WithPasswordMode(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/auth/verify", "", testPassword)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	assertVerifyMode(t, rec.Body.Bytes(), "password")
}

func TestVerifyReturns200WithPATMode(t *testing.T) {
	h := newHarness(t)
	pat := h.createPAT("test-pat", nil)

	rec := h.do(http.MethodGet, "/api/auth/verify", "", pat.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	assertVerifyMode(t, rec.Body.Bytes(), "pat")
}

func TestVerifyDoesNotAuditPasswordMode(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodGet, "/api/auth/verify", "", testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	if len(h.store.audits) != 0 {
		t.Fatalf("password mode must not audit: %+v", h.store.audits)
	}
}

func TestVerifyAuditsPATMode(t *testing.T) {
	h := newHarness(t)
	pat := h.createPAT("test-pat", nil)

	rec := h.do(http.MethodGet, "/api/auth/verify", "", pat.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	if len(h.store.audits) != 1 {
		t.Fatalf("audits = %d, want 1", len(h.store.audits))
	}
	audit := h.store.audits[0]
	if audit.PatName == nil || *audit.PatName != "test-pat" {
		t.Fatalf("audit pat name = %v", audit.PatName)
	}
	if audit.Status != http.StatusOK || audit.Outcome != "success" {
		t.Fatalf("audit = %+v", audit)
	}
}

// TS 侧断言「getDb 被调 2 次」（withAuth 一次 requireAuth + 一次审计写入），
// 以此证明 handler 没有重复调用 requireAuth。Go 侧直接数数据面调用：
// 1 次 FindPAT + 1 次 TouchPAT + 1 次 WriteAudit，多一次就说明 handler 又判了一遍。
func TestVerifyAuthenticatesPATExactlyOnce(t *testing.T) {
	h := newHarness(t)
	pat := h.createPAT("test-pat", nil)
	h.store.findCalls = 0
	h.store.touchCalls = 0

	rec := h.do(http.MethodGet, "/api/auth/verify", "", pat.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	if h.store.findCalls != 1 {
		t.Fatalf("FindPAT calls = %d, want 1 (a second requireAuth in the handler would make it 2)",
			h.store.findCalls)
	}
	if h.store.touchCalls != 1 {
		t.Fatalf("TouchPAT calls = %d, want 1", h.store.touchCalls)
	}
	if len(h.store.audits) != 1 {
		t.Fatalf("audits = %d, want 1", len(h.store.audits))
	}
}

func TestVerifyReturns200WhenAuthDisabled(t *testing.T) {
	h := newHarness(t).withAuthDisabled()

	rec := h.do(http.MethodGet, "/api/auth/verify", "", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with auth disabled", rec.Code)
	}
	assertVerifyMode(t, rec.Body.Bytes(), "disabled")
}
