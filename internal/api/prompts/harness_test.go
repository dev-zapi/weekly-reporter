package prompts_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// testPassword 与 B1/B2 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)

	passwordPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(passwordPath, []byte(`{"password":"`+testPassword+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	router := api.NewRouter(api.Options{
		Auth: auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: conn},
		},
		Queries: conn,
	})

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn}
}

func (h *harness) do(method, path, body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

func (h *harness) authed(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.do(method, path, body, testPassword)
}

func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

// seedStyle 直接写一行风格（绕过 ensureSeed），用于覆盖 CRUD 的非 seed 场景。
func (h *harness) seedStyle(key, label, stylePrompt, temperature string, detailLevel, resultOriented *string, isDefault int64, createdAt int64) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO ai_styles (key, label, system_prompt, temperature, detail_level, result_oriented, is_default, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		key, label, stylePrompt, temperature, detailLevel, resultOriented, isDefault, createdAt, createdAt,
	)
	if err != nil {
		h.t.Fatalf("seed style: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) styleRow(id int64) (key, label, stylePrompt, temperature string, detailLevel, resultOriented *string, isDefault int64) {
	h.t.Helper()
	if err := h.sqlDB.QueryRow(
		`SELECT key, label, system_prompt, temperature, detail_level, result_oriented, is_default FROM ai_styles WHERE id = ?`, id,
	).Scan(&key, &label, &stylePrompt, &temperature, &detailLevel, &resultOriented, &isDefault); err != nil {
		h.t.Fatalf("read style %d: %v", id, err)
	}
	return
}

func itoa(v int64) string {
	const digits = "0123456789"
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for v > 0 {
		pos--
		buf[pos] = digits[v%10]
		v /= 10
	}
	return string(buf[pos:])
}
