package sources_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// testPassword 与 B1 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite + 生产中间件链 +
// 本域路由，所以挂载本身也是断言的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
	// requests 记录所有走到打桩 fetch 的请求，供 branches/emails 断言用。
	requests     []*http.Request
	passwordPath string
}

// newHarness 装配只打桩远端 provider 的完整路由。
func newHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)

	passwordPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(passwordPath, []byte(`{"password":"`+testPassword+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	h := &harness{t: t, sqlDB: sqlDB, conn: conn, passwordPath: passwordPath}
	h.router = api.NewRouter(api.Options{
		Auth: auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: conn},
		},
		Queries: conn,
	})
	return h
}

// stubProvider 把远端 provider 打桩成固定响应体（状态码 + body），
// 并保留鉴权链（打桩只替换 fetch）。
func (h *harness) stubProvider(status int, body string) {
	h.t.Helper()

	h.router = api.NewRouter(api.Options{
		Auth: auth.Options{
			PasswordPath: h.passwordPath,
			Store:        auth.QueriesStore{Queries: h.conn},
		},
		Queries: h.conn,
		HTTPClient: func(request *http.Request) (*http.Response, error) {
			h.requests = append(h.requests, request)
			return &http.Response{
				StatusCode: status,
				Body:       newNopCloser(body),
				Header:     make(http.Header),
			}, nil
		},
	})
}

func (h *harness) do(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()

	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, request)
	return rec
}

// doAuthed 走密码鉴权（等价浏览器会话）。
func (h *harness) doAuthed(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()

	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+testPassword)
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, request)
	return rec
}

// seedSource 直接写一行 collect_sources（时间固定，断言不依赖当前时间）。
// 返回新行 id。
func (h *harness) seedSource(sourceType, name, config string, overrides ...func(*seedValues)) int64 {
	h.t.Helper()

	values := seedValues{
		enabled:      1,
		status:       "enabled",
		projectScope: "personal",
		createdAt:    1700000000,
		updatedAt:    1700000100,
	}
	for _, override := range overrides {
		override(&values)
	}

	var lastSyncAt any
	if values.lastSyncAt != nil {
		lastSyncAt = *values.lastSyncAt
	}
	var lastSyncStatus any
	if values.lastSyncStatus != nil {
		lastSyncStatus = *values.lastSyncStatus
	}

	res, err := h.sqlDB.Exec(
		`INSERT INTO collect_sources (type, name, config, enabled, status, project_scope, last_sync_at, last_sync_status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sourceType, name, config, values.enabled, values.status, values.projectScope, lastSyncAt, lastSyncStatus, values.createdAt, values.updatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed collect source: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

type seedValues struct {
	enabled        int64
	status         string
	projectScope   string
	lastSyncAt     *int64
	lastSyncStatus *string
	createdAt      int64
	updatedAt      int64
}

func withLastSync(at int64, status string) func(*seedValues) {
	return func(v *seedValues) {
		v.lastSyncAt = &at
		v.lastSyncStatus = &status
	}
}

func withNeverSynced() func(*seedValues) {
	return func(v *seedValues) {
		v.lastSyncAt = nil
		v.lastSyncStatus = nil
	}
}

// sourceRow 是断言用的行快照。
type sourceRow struct {
	ID             int64
	Type           string
	Name           string
	Config         string
	Enabled        int64
	Status         *string
	ProjectScope   string
	LastSyncAt     *int64
	LastSyncStatus *string
	CreatedAt      int64
	UpdatedAt      int64
}

func (h *harness) load(id int64) sourceRow {
	h.t.Helper()

	var row sourceRow
	err := h.sqlDB.QueryRow(
		`SELECT id, type, name, config, enabled, status, project_scope, last_sync_at, last_sync_status, created_at, updated_at
		 FROM collect_sources WHERE id = ?`, id,
	).Scan(&row.ID, &row.Type, &row.Name, &row.Config, &row.Enabled, &row.Status, &row.ProjectScope, &row.LastSyncAt, &row.LastSyncStatus, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		h.t.Fatalf("load collect source %d: %v", id, err)
	}
	return row
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// nopCloser 把字符串包成 io.ReadCloser（避免测试文件里再引 io）。
type nopCloser struct{ reader *strings.Reader }

func newNopCloser(body string) *nopCloser { return &nopCloser{reader: strings.NewReader(body)} }

func (n *nopCloser) Read(p []byte) (int, error) { return n.reader.Read(p) }
func (n *nopCloser) Close() error               { return nil }
