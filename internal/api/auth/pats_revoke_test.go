package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
)

// 本文件是 src/app/api/auth/pats/[id]/route.test.ts 的 Go 同用例集（ADR-0029）：
// 7 个用例逐条对应。其中两条「已吊销 PAT 不可用 / 吊销失败审计」原本打的是
// ../../verify/route，Go 侧同义（verify handler 经由同一中间件与域路由）。

func revokeURL(id string) string { return "/api/auth/pats/" + id }

func TestRevokePATReturns401WhenNotAuthenticated(t *testing.T) {
	h := newHarness(t)
	h.createPAT("target-pat", nil)

	rec := h.do(http.MethodDelete, idPath(1), "", "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRevokePATReturns204AndSetsRevokedAt(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	target := h.createPAT("target-pat", nil)

	rec := h.do(http.MethodDelete, idPath(target.ID), "", authPAT.Token)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %s)", rec.Code, rec.Body.String())
	}
	// 204 必须没有 body、没有 content-type。
	if rec.Body.Len() != 0 {
		t.Fatalf("204 body = %q, want empty", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "" {
		t.Fatalf("204 content-type = %q, want none", ct)
	}

	row, err := auth.FindPATByToken(context.Background(), h.conn, target.Token)
	if err != nil {
		t.Fatal(err)
	}
	if row.RevokedAt == nil {
		t.Fatalf("revokedAt = nil, want a timestamp")
	}
	// 行必须保留（审计可追溯），不是删除。
	if row.Name != "target-pat" {
		t.Fatalf("row = %+v", row)
	}
}

func TestRevokePATReturns404WhenNotFound(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodDelete, idPath(999), "", authPAT.Token)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "NOT_FOUND" || body.Error != "PAT not found" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRevokePATReturns400WhenIDIsInvalid(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)

	rec := h.do(http.MethodDelete, "/api/auth/pats/invalid", "", authPAT.Token)

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
	if body.Code != "INVALID_ID" || body.Error != "Invalid PAT ID" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// 票内点名的 parseInt 语义：`12abc` 在 JS 里是 12，不是 400。
// TS 用例没覆盖这条，Go 侧照 route.ts 行为实现并断言。
func TestRevokePATParsesLeadingDigitsLikeJSParseInt(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	target := h.createPAT("target-pat", nil)

	rec := h.do(http.MethodDelete, idPath(target.ID)+"abc", "", authPAT.Token)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 for %q (parseInt semantics)", rec.Code, strconv.FormatInt(target.ID, 10)+"abc")
	}
}

// 已吊销的再吊一次也是 204（票内明确要求），且不覆盖首次的 revoked_at。
func TestRevokePATIsIdempotent(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	target := h.createPAT("target-pat", nil)

	first := h.do(http.MethodDelete, idPath(target.ID), "", authPAT.Token)
	if first.Code != http.StatusNoContent {
		t.Fatalf("first status = %d", first.Code)
	}
	row, err := auth.FindPATByToken(context.Background(), h.conn, target.Token)
	if err != nil {
		t.Fatal(err)
	}
	firstRevokedAt := *row.RevokedAt

	second := h.do(http.MethodDelete, idPath(target.ID), "", authPAT.Token)
	if second.Code != http.StatusNoContent {
		t.Fatalf("second status = %d, want 204", second.Code)
	}

	row, err = auth.FindPATByToken(context.Background(), h.conn, target.Token)
	if err != nil {
		t.Fatal(err)
	}
	if *row.RevokedAt != firstRevokedAt {
		t.Fatalf("revokedAt = %d, want the original %d", *row.RevokedAt, firstRevokedAt)
	}
}

func TestRevokedPATCannotBeUsed(t *testing.T) {
	h := newHarness(t)
	target := h.createPAT("target-pat", nil)

	if rec := h.do(http.MethodDelete, idPath(target.ID), "", target.Token); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d", rec.Code)
	}

	rec := h.do(http.MethodGet, "/api/auth/verify", "", target.Token)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for a revoked PAT", rec.Code)
	}
}

func TestRevokePATRecordsAudit(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat", nil)
	target := h.createPAT("target-pat", nil)

	if rec := h.do(http.MethodDelete, idPath(target.ID), "", authPAT.Token); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}

	if len(h.store.audits) != 1 {
		t.Fatalf("audits = %d, want 1", len(h.store.audits))
	}
	audit := h.store.audits[0]
	if audit.PatName == nil || *audit.PatName != "auth-pat" {
		t.Fatalf("audit pat name = %v", audit.PatName)
	}
	if audit.Status != http.StatusNoContent || audit.Outcome != "success" {
		t.Fatalf("audit = %+v", audit)
	}

	// 目标 PAT 自身的吊销动作不额外留痕：审计只记调用方。
	for _, a := range h.store.audits {
		if a.PatName != nil && *a.PatName == "target-pat" {
			t.Fatalf("revocation must not audit the target PAT: %+v", a)
		}
	}
}

func TestRevokedPATUsageRecordsUnauthorizedAudit(t *testing.T) {
	h := newHarness(t)
	target := h.createPAT("target-pat", nil)

	if rec := h.do(http.MethodDelete, idPath(target.ID), "", target.Token); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d", rec.Code)
	}

	if rec := h.do(http.MethodGet, "/api/auth/verify", "", target.Token); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}

	// 吊销请求本身一条（成功），被吊销 PAT 的调用一条（401 unauthorized）。
	if len(h.store.audits) != 2 {
		t.Fatalf("audits = %d, want 2: %+v", len(h.store.audits), h.store.audits)
	}
	failed := h.store.audits[1]
	if failed.PatName == nil || *failed.PatName != "target-pat" {
		t.Fatalf("audit pat name = %v", failed.PatName)
	}
	if failed.Status != http.StatusUnauthorized || failed.Outcome != "unauthorized" {
		t.Fatalf("audit = %+v", failed)
	}
}

// 工具函数：把 PAT id 拼进 URL。
func idPath(id int64) string { return "/api/auth/pats/" + strconv.FormatInt(id, 10) }
