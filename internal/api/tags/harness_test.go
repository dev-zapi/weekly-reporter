package tags

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
	"github.com/dev-zapi/weekly-reporter/internal/trace"
)

// testPassword 与 B1 夹具同角色：一个密码请求 = 浏览器登录成功，且不写审计行，
// 所以测试里数行数时不会把认证本身算进去。
const testPassword = "correct-password"

// harness 装配真实 SQLite（schema.sql 全量）+ 真实 auth 中间件 + 本域路由，
// 断言跑在生产的中间件链上（ADR-0029 的「同用例集」要求）。
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

	r := chi.NewRouter()
	r.Use(trace.Middleware)
	r.Route("/api", func(r chi.Router) {
		r.Use(auth.Middleware(auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: conn},
		}))
		Mount(r, Deps{Queries: conn})
	})

	return &harness{t: t, router: r, sqlDB: sqlDB, conn: conn}
}

// do 发一个请求。body 为空表示无请求体；token 为空表示不带 Authorization 头。
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

// seedEvent 直接写一行 raw_events，content 是按 ADR-0012 双存储里「文本那一半」。
func (h *harness) seedEvent(content, source string, eventTime int64) int64 {
	h.t.Helper()

	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		eventTime, source, content, eventTime, eventTime,
	)
	if err != nil {
		h.t.Fatalf("seed event: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// seedTag 写关联表那一半。createdAt 固定，避免测试依赖当前时间。
func (h *harness) seedTag(eventID int64, tagName string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_tags (event_id, tag_name, created_at) VALUES (?, ?, ?)`,
		eventID, tagName, int64(1_700_000_000),
	); err != nil {
		h.t.Fatalf("seed tag: %v", err)
	}
}

func (h *harness) eventContent(id int64) string {
	h.t.Helper()
	var content string
	if err := h.sqlDB.QueryRow(`SELECT content FROM raw_events WHERE id = ?`, id).Scan(&content); err != nil {
		h.t.Fatalf("read event %d: %v", id, err)
	}
	return content
}

func (h *harness) tagNames(eventID int64) []string {
	h.t.Helper()
	rows, err := h.sqlDB.Query(`SELECT tag_name FROM event_tags WHERE event_id = ? ORDER BY tag_name`, eventID)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			h.t.Fatal(err)
		}
		names = append(names, name)
	}
	return names
}

// breakDB 关掉底层连接，用来复现 route.ts 的 catch 分支（500 + FETCH_ERROR 等）。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}
