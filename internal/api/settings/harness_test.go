package settings_test

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// testPassword 与 B1/B2 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// providerRequest 是打到 mock provider 的一次出站请求。Body 已读完（provider
// 处理链会消费 request body）。
type providerRequest struct {
	Method string
	Path   string
	Header http.Header
	Body   string
}

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite + 生产中间件链 +
// 本域路由，挂载本身也是断言的一部分。
//
// provider 是一个真 HTTP 端点（httptest.Server），settings/ai 的 models/test 探测
// 走真实网络栈；测试用 apiUrl 指向它，因此不需要在 handler 里打桩 fetch。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries

	provider        *httptest.Server
	mu              sync.Mutex
	requests        []providerRequest
	providerHandler http.HandlerFunc
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)

	h := &harness{t: t, sqlDB: sqlDB, conn: conn}
	h.provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		h.requests = append(h.requests, providerRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Header: r.Header.Clone(),
			Body:   string(body),
		})
		handler := h.providerHandler
		h.mu.Unlock()
		if handler == nil {
			http.NotFound(w, r)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(h.provider.Close)

	passwordPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(passwordPath, []byte(`{"password":"`+testPassword+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	h.router = api.NewRouter(api.Options{
		Auth: auth.Options{
			PasswordPath: passwordPath,
			Store:        auth.QueriesStore{Queries: conn},
		},
		Queries:    conn,
		HTTPClient: h.provider.Client().Do,
	})
	return h
}

// setProvider 换掉 mock provider 的处理函数（nil 之外）。
func (h *harness) setProvider(handler http.HandlerFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.providerHandler = handler
}

// providerRequests 返回目前收到的出站请求快照。
func (h *harness) providerRequests() []providerRequest {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]providerRequest, len(h.requests))
	copy(out, h.requests)
	return out
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

// seedAIConfig 直接写一行 ai_config。cache 为 nil 表示 SQL NULL；cache 是原始
// JSON 文本（drizzle json mode 在库里存 TEXT）。
func (h *harness) seedAIConfig(protocol, apiURL, apiKey, model string, cache *string, cachedAt *int64, createdAt, updatedAt int64) int64 {
	h.t.Helper()

	var cacheValue any
	if cache != nil {
		cacheValue = *cache
	}
	var cachedAtValue any
	if cachedAt != nil {
		cachedAtValue = *cachedAt
	}
	res, err := h.sqlDB.Exec(
		`INSERT INTO ai_config (protocol, api_url, api_key, model, model_list_cache, model_list_cached_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		protocol, apiURL, apiKey, model, cacheValue, cachedAtValue, createdAt, updatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed ai_config: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// aiConfigRow 是直接读库的投影，用来断言写路径（含 model_list_cache 的存储类型）。
type aiConfigRow struct {
	ID                int64
	Protocol          string
	APIURL            string
	APIKey            string
	Model             string
	CacheType         string
	Cache             string
	CacheCachedAt     *int64
	CreatedAt         int64
	UpdatedAt         int64
}

func (h *harness) aiConfig() *aiConfigRow {
	h.t.Helper()

	row := h.sqlDB.QueryRow(
		`SELECT id, protocol, api_url, api_key, model, typeof(model_list_cache), COALESCE(model_list_cache, ''), model_list_cached_at, created_at, updated_at
		 FROM ai_config LIMIT 1`)
	var out aiConfigRow
	if err := row.Scan(&out.ID, &out.Protocol, &out.APIURL, &out.APIKey, &out.Model, &out.CacheType, &out.Cache, &out.CacheCachedAt, &out.CreatedAt, &out.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		h.t.Fatalf("read ai_config: %v", err)
	}
	return &out
}

// aiConfigCount 返回 ai_config 行数。
func (h *harness) aiConfigCount() int {
	h.t.Helper()
	var count int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM ai_config`).Scan(&count); err != nil {
		h.t.Fatalf("count ai_config: %v", err)
	}
	return count
}

// breakDB 关掉底层连接，用来复现 route.ts 的 catch 分支（500 + 错误码）。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

// decodeObject 把响应体解成通用 JSON 对象，供「形状与字段值」断言用。
func decodeObject(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode body %s: %v", rec.Body.String(), err)
	}
	return out
}

// assertExactJSON 断言响应体正好是 want（键集合与值都相等，忽略键序）。
func assertExactJSON(t *testing.T, rec *httptest.ResponseRecorder, want map[string]any) {
	t.Helper()
	got := decodeObject(t, rec)
	if !jsonEqual(got, want) {
		t.Fatalf("body = %s, want %v", rec.Body.String(), want)
	}
}

func jsonEqual(a, b map[string]any) bool {
	left, err := json.Marshal(a)
	if err != nil {
		return false
	}
	right, err := json.Marshal(b)
	if err != nil {
		return false
	}
	return string(left) == string(right)
}

// assertError 断言 `{error, code}` 形状与状态码。
func (h *harness) assertError(rec *httptest.ResponseRecorder, status int, message, code string) {
	h.t.Helper()
	if rec.Code != status {
		h.t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	body := decodeObject(h.t, rec)
	if body["error"] != message || body["code"] != code {
		h.t.Fatalf("body = %s, want error=%q code=%q", rec.Body.String(), message, code)
	}
}

func int64Ptr(v int64) *int64 { return &v }
func strPtr(v string) *string { return &v }

// marshalString 用标准库把字符串编成 JSON 字面量（测试里拼 body 用）。
func marshalString(value string) (string, error) {
	encoded, err := json.Marshal(value)
	return string(encoded), err
}
