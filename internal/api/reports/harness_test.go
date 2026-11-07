package reports_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite + 生产中间件链 +
// 本域路由。鉴权关掉（Disabled），路由挂载本身也是断言的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithOptions(t, api.Options{})
}

// newHarnessWithOptions 允许生成域测试注入 engine 的 mock provider。
func newHarnessWithOptions(t *testing.T, opts api.Options) *harness {
	t.Helper()

	sqlDB := dbtest.New(t)
	conn := db.New(sqlDB)

	opts.Auth = auth.Options{Disabled: true}
	opts.Queries = conn
	router := api.NewRouter(opts)

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn}
}

// seedAIConfig 写一行 ai_config（生成引擎/一次性生成都要读它）。
func (h *harness) seedAIConfig(protocol, apiURL, model string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO ai_config (protocol, api_url, api_key, model, created_at, updated_at)
		 VALUES (?, ?, 'test-key', ?, 1700000000, 1700000000)`,
		protocol, apiURL, model,
	); err != nil {
		h.t.Fatalf("seed ai_config: %v", err)
	}
}

// seedTemplate 写一行用户模板（getTemplateSelection 的 user-<id> 形态）。
func (h *harness) seedTemplate(id int64, name, content, aiStyle string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO templates (id, name, content, ai_style, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1700000000, 1700000000)`,
		id, name, content, aiStyle,
	); err != nil {
		h.t.Fatalf("seed template: %v", err)
	}
}

func (h *harness) do(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// seedReport 直接写一行 reports，返回自增 id。时间固定，断言不依赖当前时间。
func (h *harness) seedReport(title, content, weekStart, weekEnd string, createdAt int64) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO reports (title, content, week_start, week_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		title, content, weekStart, weekEnd, createdAt, createdAt,
	)
	if err != nil {
		h.t.Fatalf("seed report: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// seedVariant 直接写一行 report_variants。
func (h *harness) seedVariant(reportID int64, variant, sourceDraft string, finalContent *string, sourceRevision int64, acceptedProposalID *int64) int64 {
	h.t.Helper()
	var final any
	if finalContent != nil {
		final = *finalContent
	}
	var accepted any
	if acceptedProposalID != nil {
		accepted = *acceptedProposalID
	}
	res, err := h.sqlDB.Exec(
		`INSERT INTO report_variants (report_id, variant, source_draft, final_content, final_status, source_revision, accepted_proposal_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1700000000, 1700000100)`,
		reportID, variant, sourceDraft, final, finalStatus(finalContent), sourceRevision, accepted,
	)
	if err != nil {
		h.t.Fatalf("seed variant: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func finalStatus(finalContent *string) string {
	if finalContent == nil {
		return "none"
	}
	return "current"
}

// seedEvent 直接写一行 raw_events（metadata 是 JSON 文本）。
func (h *harness) seedEvent(eventTime int64, source, content, metadata string) int64 {
	h.t.Helper()
	var metadataValue any
	if metadata != "" {
		metadataValue = metadata
	}
	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		eventTime, source, content, metadataValue, eventTime, eventTime,
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

// seedCollectSource 直接写一行 collect_sources（只填本域用到的列）。
func (h *harness) seedCollectSource(name, projectScope string) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO collect_sources (type, name, config, enabled, status, project_scope, created_at, updated_at)
		 VALUES ('git-local', ?, '{}', 1, 'enabled', ?, 1700000000, 1700000100)`,
		name, projectScope,
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

// seedSession 直接写一行 generation_sessions，返回 id。
func (h *harness) seedSession(reportID, reportVariantID int64, variant, title string, sourceRevision int64, updatedAt int64) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO generation_sessions (
			report_id, report_variant_id, variant, title, status, source_revision, source_draft_snapshot,
			source_overview, template_id, template_name, template_content, ai_style_key, ai_style_label,
			ai_style_prompt, temperature, system_prompt, tool_rules, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'active', ?, '-', '-', 'official-general', '通用', '# 模板', 'formal', '正式汇报', 'p', '0.3', 's', 't', ?, ?)`,
		reportID, reportVariantID, variant, title, sourceRevision, updatedAt-10, updatedAt,
	)
	if err != nil {
		h.t.Fatalf("seed session: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// seedStyle / seedSystemPrompt 直接写提示词表（createGenerationSession 需要）。
func (h *harness) seedStyle(key, label, prompt, temperature string, isDefault bool) {
	h.t.Helper()
	flag := 0
	if isDefault {
		flag = 1
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO ai_styles (key, label, system_prompt, temperature, is_default, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 1700000000, 1700000100)`,
		key, label, prompt, temperature, flag,
	); err != nil {
		h.t.Fatalf("seed style: %v", err)
	}
}

func (h *harness) seedSystemPrompt(key, label, text string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO system_prompts (key, label, prompt_text, created_at, updated_at) VALUES (?, ?, ?, 1700000000, 1700000100)`,
		key, label, text,
	); err != nil {
		h.t.Fatalf("seed system prompt: %v", err)
	}
}

// breakDB 关掉底层库，模拟数据库错误（route.ts 的 catch 分支）。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

func itoa(value int64) string { return strconv.FormatInt(value, 10) }
