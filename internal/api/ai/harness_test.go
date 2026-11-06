package ai_test

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

// testPassword 与 B1/B2 夹具同角色：密码请求 = 浏览器登录成功。
const testPassword = "correct-password"

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite + 生产中间件链 +
// 本域路由，挂载本身也是断言的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
	mock   *mockProvider
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)
	mock := newMockProvider(t)

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

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn, mock: mock}
}

// do 发一个请求。body 为空表示无请求体；token 为空表示不带 Authorization 头。
func (h *harness) do(path, body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(http.MethodPost, path, nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// seedAIConfig 写一行 ai_config，api_url 指向 mock provider。protocol 固定为
// 生产库里真实的 "openai"（Responses API）。
func (h *harness) seedAIConfig(protocol, apiURL, model string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO ai_config (protocol, api_url, api_key, model, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		protocol, apiURL, "test-key", model, int64(1_700_000_000), int64(1_700_000_000),
	); err != nil {
		h.t.Fatalf("seed ai_config: %v", err)
	}
}

// seedStyle 写一行 ai_styles。temperature 是 TEXT 列，按 drizzle 的属性名给值。
func (h *harness) seedStyle(key, label, systemPrompt, temperature string, isDefault bool) {
	h.t.Helper()
	defaultInt := 0
	if isDefault {
		defaultInt = 1
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO ai_styles (key, label, system_prompt, temperature, is_default, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		key, label, systemPrompt, temperature, defaultInt, int64(1_700_000_000), int64(1_700_000_000),
	); err != nil {
		h.t.Fatalf("seed ai_style %s: %v", key, err)
	}
}

// seedTemplate 写一行 templates，只需 id / ai_style 与必填列。
func (h *harness) seedTemplate(id int64, aiStyle string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO templates (id, name, content, ai_style, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, "模板", "{{content}}", aiStyle, int64(1_700_000_000), int64(1_700_000_000),
	); err != nil {
		h.t.Fatalf("seed template %d: %v", id, err)
	}
}

// breakDB 关掉底层连接，用来复现 route.ts 里「风格查询抛错」的 catch 分支。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

// mockProvider 是票面要求的「mock provider fixture」：一个真的 HTTP 端点，
// 按 Responses API 的形状回一次（或多次）JSON，并记录收到的请求体。
type mockProvider struct {
	t      *testing.T
	server *httptest.Server

	mu       sync.Mutex
	requests []recordedRequest
	// reply 返回响应体与状态码；nil 表示用默认的结构化输出响应。
	reply func(recordedRequest) (int, string)
	// text 是默认响应里模型「输出」的那段 JSON。
	text string
}

type recordedRequest struct {
	Path string
	Body map[string]any
	Raw  string
}

func newMockProvider(t *testing.T) *mockProvider {
	t.Helper()

	m := &mockProvider{t: t}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if err != nil {
			t.Errorf("read provider request: %v", err)
		}

		var body map[string]any
		_ = json.Unmarshal(raw, &body)

		recorded := recordedRequest{Path: r.URL.Path, Body: body, Raw: string(raw)}

		m.mu.Lock()
		m.requests = append(m.requests, recorded)
		reply, text := m.reply, m.text
		m.mu.Unlock()

		status, payload := http.StatusOK, m.responsesBody(text)
		if reply != nil {
			status, payload = reply(recorded)
		}

		w.Header().Set("Content-Type", "application/json")
		if status < 200 || status > 299 {
			// 错误响应带 retry-after-ms: 0：aiclient 复刻了 AI SDK 的重试，
			// 这里让重试立即发生，测试不等待指数退避。
			w.Header().Set("Retry-After-Ms", "0")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockProvider) url() string { return m.server.URL }

// responsesBody 拼一个 Responses API 的成功响应，模型输出就是 text。
func (m *mockProvider) responsesBody(text string) string {
	body := map[string]any{
		"id":    "resp_mock",
		"model": "mock-model",
		"output": []any{map[string]any{
			"type": "message",
			"role": "assistant",
			"content": []any{map[string]any{
				"type": "output_text",
				"text": text,
			}},
		}},
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

// setText 设定默认响应里模型输出的 JSON 文本。
func (m *mockProvider) setText(text string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.text = text
}

// setReply 覆盖响应生成（用于错误分支）。
func (m *mockProvider) setReply(reply func(recordedRequest) (int, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reply = reply
}

// received 返回到目前为止收到的请求。
func (m *mockProvider) received() []recordedRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]recordedRequest(nil), m.requests...)
}

// lastRequest 返回最后一次请求；没有请求时 Fatal。
func (m *mockProvider) lastRequest() recordedRequest {
	m.t.Helper()
	all := m.received()
	if len(all) == 0 {
		m.t.Fatal("mock provider received no request")
	}
	return all[len(all)-1]
}
