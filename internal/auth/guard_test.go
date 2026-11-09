package auth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeStore 让 guard 单测完全不碰数据库：Store 接口就是鉴权所需的全部数据面。
type fakeStore struct {
	pat      PAT
	found    bool
	findErr  error
	touched  []int64
	audits   []AuditRecord
	auditErr error
}

func (f *fakeStore) FindPAT(_ context.Context, tokenHash string) (PAT, error) {
	if f.findErr != nil {
		return PAT{}, f.findErr
	}
	if !f.found {
		return PAT{}, ErrPATNotFound
	}
	return f.pat, nil
}

func (f *fakeStore) TouchPAT(_ context.Context, id int64, atMillis int64) error {
	f.touched = append(f.touched, atMillis)
	return nil
}

func (f *fakeStore) WriteAudit(_ context.Context, rec AuditRecord) error {
	f.audits = append(f.audits, rec)
	return f.auditErr
}

func writePasswordFile(t *testing.T, dir string, contents string) string {
	t.Helper()
	configDir := filepath.Join(dir, "weekly-reporter")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(configDir, "auth.json")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func doRequest(t *testing.T, handler http.Handler, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://localhost:6868/api/events", nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestGuardDisabledBypassesEverything(t *testing.T) {
	store := &fakeStore{findErr: errors.New("must not be called")}
	handler := Middleware(Options{Disabled: true, Store: store})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	rec := doRequest(t, handler, "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(store.audits) != 0 || len(store.touched) != 0 {
		t.Fatalf("disabled mode must not audit or touch: %+v", store)
	}
}

func TestGuardRejectsWithoutAuditing(t *testing.T) {
	dir := t.TempDir()
	passwordPath := writePasswordFile(t, dir, `{"password":"secret"}`)

	cases := map[string]string{
		"no header":        "",
		"non bearer":       "Basic abc",
		"empty bearer":     "Bearer    ",
		"bearer lowercase": "bearer secret",
	}
	for name, header := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{}
			handler := Middleware(Options{PasswordPath: passwordPath, Store: store})(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					t.Fatalf("handler must not run")
				}))

			rec := doRequest(t, handler, header)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d", rec.Code)
			}
			if len(store.audits) != 0 {
				t.Fatalf("unauthorized without a PAT name must not be audited: %+v", store.audits)
			}
			if got := rec.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("content-type = %q", got)
			}
			body, _ := io.ReadAll(rec.Body)
			if string(body) != `{"error":"Unauthorized"}` {
				t.Fatalf("body = %s", body)
			}
		})
	}
}

func TestGuardAcceptsStartupPasswordWithoutAudit(t *testing.T) {
	dir := t.TempDir()
	passwordPath := writePasswordFile(t, dir, `{"password":"secret"}`)
	store := &fakeStore{findErr: errors.New("password path must not query PATs")}

	handler := Middleware(Options{PasswordPath: passwordPath, Store: store})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	rec := doRequest(t, handler, "Bearer secret")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(store.audits) != 0 || len(store.touched) != 0 {
		t.Fatalf("password mode must not audit or touch: %+v", store)
	}
}

func TestGuardAuditsFailedPATEverywhere(t *testing.T) {
	dir := t.TempDir()
	passwordPath := writePasswordFile(t, dir, `{"password":"secret"}`)
	nowMillis := time.Now().UnixMilli()
	expired := nowMillis - 1000
	revoked := nowMillis - 1000

	cases := []struct {
		name        string
		store       *fakeStore
		wantPATName *string
	}{
		{name: "unknown PAT", store: &fakeStore{}, wantPATName: nil},
		{
			name:        "revoked PAT",
			store:       &fakeStore{found: true, pat: PAT{ID: 7, Name: "revoked", RevokedAtMillis: &revoked}},
			wantPATName: strPtr("revoked"),
		},
		{
			name:        "expired PAT",
			store:       &fakeStore{found: true, pat: PAT{ID: 7, Name: "expired", ExpiresAtMillis: &expired}},
			wantPATName: strPtr("expired"),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := Middleware(Options{PasswordPath: passwordPath, Store: tc.store})(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					t.Fatalf("handler must not run")
				}))

			rec := doRequest(t, handler, "Bearer wrp_token")

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d", rec.Code)
			}
			if len(tc.store.audits) != 1 {
				t.Fatalf("audits = %d, want 1", len(tc.store.audits))
			}
			audit := tc.store.audits[0]
			if audit.Status != http.StatusUnauthorized || audit.Outcome != "unauthorized" {
				t.Fatalf("audit = %+v", audit)
			}
			if !equalPtr(audit.PatName, tc.wantPATName) {
				t.Fatalf("audit pat name = %v, want %v", audit.PatName, tc.wantPATName)
			}
			if audit.APIPath != "/api/events" || audit.Method != http.MethodGet {
				t.Fatalf("audit identity = %+v", audit)
			}
		})
	}
}

func TestGuardAcceptsValidPATAndAuditsFinalStatus(t *testing.T) {
	dir := t.TempDir()
	passwordPath := writePasswordFile(t, dir, `{"password":"secret"}`)
	store := &fakeStore{found: true, pat: PAT{ID: 7, Name: "agent"}}

	handler := Middleware(Options{PasswordPath: passwordPath, Store: store})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))

	rec := doRequest(t, handler, "Bearer wrp_token")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(store.touched) != 1 {
		t.Fatalf("touch calls = %d, want 1", len(store.touched))
	}
	if len(store.audits) != 1 {
		t.Fatalf("audits = %d, want 1", len(store.audits))
	}
	audit := store.audits[0]
	if audit.Status != http.StatusInternalServerError || audit.Outcome != "success" {
		t.Fatalf("audit = %+v", audit)
	}
	if audit.PatName == nil || *audit.PatName != "agent" {
		t.Fatalf("audit pat name = %v", audit.PatName)
	}
}

func TestGuardAuditFailureDoesNotBreakResponse(t *testing.T) {
	dir := t.TempDir()
	passwordPath := writePasswordFile(t, dir, `{"password":"secret"}`)
	store := &fakeStore{found: true, pat: PAT{ID: 7, Name: "agent"}, auditErr: errors.New("db down")}

	handler := Middleware(Options{PasswordPath: passwordPath, Store: store})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	rec := doRequest(t, handler, "Bearer wrp_token")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, response must survive an audit failure", rec.Code)
	}
}

func TestGuardRecordsCallerIdentityHeaders(t *testing.T) {
	dir := t.TempDir()
	passwordPath := writePasswordFile(t, dir, `{"password":"secret"}`)
	store := &fakeStore{found: true, pat: PAT{ID: 7, Name: "agent"}}

	handler := Middleware(Options{PasswordPath: passwordPath, Store: store})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	req := httptest.NewRequest(http.MethodPost, "http://localhost:6868/api/events?x=1", nil)
	req.Header.Set("Authorization", "Bearer wrp_token")
	req.Header.Set("User-Agent", "curl/8")
	req.Header.Set("X-Weekly-Reporter-Agent", "weekly-reporter/claude-code")
	req.Header.Set("X-Weekly-Reporter-Cwd", "/tmp/project")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if len(store.audits) != 1 {
		t.Fatalf("audits = %d", len(store.audits))
	}
	audit := store.audits[0]
	assertPtr(t, "user agent", audit.UserAgent, "curl/8")
	assertPtr(t, "agent identity", audit.AgentIdentity, "weekly-reporter/claude-code")
	assertPtr(t, "caller cwd", audit.CallerCwd, "/tmp/project")
	if audit.APIPath != "/api/events" {
		t.Fatalf("api path = %q", audit.APIPath)
	}
}

func TestReadStartupPasswordFromExistingDeploymentFormat(t *testing.T) {
	dir := t.TempDir()
	// 与 ~/.config/weekly-reporter/auth.json 的现行形状完全一致：
	// 明文 password + machine 凭据同文件。
	path := writePasswordFile(t, dir, `{
  "password": "O55GmntiRBnfE2lVuyZ3Pd94KzWM2iyA8BR6nDYHjuLlUhGr",
  "machine": {
    "pat": "wrp_xWistm8wVg7FkDBVF89nYpARm1QXNrby",
    "baseUrl": "http://127.0.0.1:6868"
  }
}`)

	if got, want := ReadStartupPassword(path), "O55GmntiRBnfE2lVuyZ3Pd94KzWM2iyA8BR6nDYHjuLlUhGr"; got != want {
		t.Fatalf("ReadStartupPassword() = %q, want %q", got, want)
	}
}

func TestReadStartupPasswordToleratesMissingAndCorruptFiles(t *testing.T) {
	if got := ReadStartupPassword(filepath.Join(t.TempDir(), "nope.json")); got != "" {
		t.Fatalf("missing file -> %q, want empty", got)
	}
	path := writePasswordFile(t, t.TempDir(), `{not json`)
	if got := ReadStartupPassword(path); got != "" {
		t.Fatalf("corrupt file -> %q, want empty", got)
	}
	path = writePasswordFile(t, t.TempDir(), `{"password":""}`)
	if got := ReadStartupPassword(path); got != "" {
		t.Fatalf("empty password -> %q, want empty", got)
	}
}

func TestReadAuthConfigKeepsMachineCredential(t *testing.T) {
	path := writePasswordFile(t, t.TempDir(), `{
  "password": "pw",
  "machine": {"baseUrl": "http://127.0.0.1:6868", "pat": "wrp_x"}
}`)

	cfg, ok := ReadAuthConfig(path)
	if !ok {
		t.Fatalf("config not read")
	}
	if cfg.Machine == nil || cfg.Machine.BaseURL != "http://127.0.0.1:6868" || cfg.Machine.PAT != "wrp_x" {
		t.Fatalf("machine = %+v", cfg.Machine)
	}
}

func TestTimingSafeEqualString(t *testing.T) {
	if !timingSafeEqualString("abc", "abc") {
		t.Fatalf("equal strings rejected")
	}
	if timingSafeEqualString("abc", "abd") {
		t.Fatalf("different strings accepted")
	}
	// 长度不同也必须返回 false 而不是 panic（双侧 SHA-256 消除了长度侧信道）。
	if timingSafeEqualString("abc", "abcdef") {
		t.Fatalf("different lengths accepted")
	}
}

func strPtr(s string) *string { return &s }

func equalPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func assertPtr(t *testing.T, label string, got *string, want string) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("%s = %v, want %q", label, got, want)
	}
}
