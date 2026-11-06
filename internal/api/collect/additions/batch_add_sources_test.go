package additions_test

import (
	"encoding/json"
	"strings"
	"testing"
)

type collectSourceRow struct {
	Type         string
	Name         string
	Config       string
	Enabled      int64
	Status       string
	ProjectScope string
	CreatedAt    int64
	UpdatedAt    int64
}

func (h *harness) gitLocalRows(t *testing.T) []collectSourceRow {
	t.Helper()

	rows, err := h.sqlDB.Query(
		`SELECT type, name, config, enabled, status, project_scope, created_at, updated_at
		 FROM collect_sources WHERE type = 'git-local' ORDER BY id`,
	)
	if err != nil {
		t.Fatalf("query collect sources: %v", err)
	}
	defer rows.Close()

	var out []collectSourceRow
	for rows.Next() {
		var row collectSourceRow
		if err := rows.Scan(&row.Type, &row.Name, &row.Config, &row.Enabled, &row.Status, &row.ProjectScope, &row.CreatedAt, &row.UpdatedAt); err != nil {
			t.Fatalf("scan collect source: %v", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate collect sources: %v", err)
	}
	return out
}

// 成功路径：逐条插入 type='git-local'，config 形状与 actions.ts 一致
// （owner / authorEmails / branches: []），时间戳是同一个 Unix 秒的 created/updated。
func TestBatchAddSourcesCreatesGitLocalSources(t *testing.T) {
	h := newHarness(t)

	body := `{"repos":[` +
		`{"path":"/tmp/ws/alpha","name":"alpha","authorEmails":["a@example.com","b@example.com"]},` +
		`{"path":"/tmp/ws/beta","name":"beta","authorEmails":[]}` +
		`]}`
	rec := h.post("/api/collect/batch-add-sources", body)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	response := decodeBody(t, rec)
	if response["success"] != true {
		t.Fatalf("success = %v, want true", response["success"])
	}
	if response["addedCount"] != float64(2) {
		t.Fatalf("addedCount = %v, want 2", response["addedCount"])
	}
	if value, ok := response["error"]; ok {
		t.Fatalf("unexpected error field: %v", value)
	}

	rows := h.gitLocalRows(t)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}

	alpha := rows[0]
	if alpha.Name != "alpha" || alpha.Enabled != 1 || alpha.Status != "enabled" || alpha.ProjectScope != "personal" {
		t.Fatalf("alpha row = %+v", alpha)
	}
	if alpha.Config != `{"owner":"/tmp/ws/alpha","authorEmails":["a@example.com","b@example.com"],"branches":[]}` {
		t.Fatalf("alpha config = %s", alpha.Config)
	}
	if alpha.CreatedAt <= 0 || alpha.CreatedAt != alpha.UpdatedAt {
		t.Fatalf("alpha timestamps = %d/%d, want one positive shared Unix second", alpha.CreatedAt, alpha.UpdatedAt)
	}

	beta := rows[1]
	if beta.Config != `{"owner":"/tmp/ws/beta","authorEmails":[],"branches":[]}` {
		t.Fatalf("beta config = %s", beta.Config)
	}
}

// 去重：已存在的 git-local source（config.owner 相同）跳过；同一次请求里重复的
// path 也只插一行。非 git-local 的 owner 不参与去重（actions.ts 的 eq(type,'git-local')）。
func TestBatchAddSourcesSkipsKnownPaths(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-local", "alpha", `{"owner":"/tmp/ws/alpha"}`)
	h.seedSource("git-remote", "gamma-remote", `{"owner":"/tmp/ws/gamma"}`)

	body := `{"repos":[` +
		`{"path":"/tmp/ws/alpha","name":"alpha","authorEmails":[]},` +
		`{"path":"/tmp/ws/gamma","name":"gamma","authorEmails":[]},` +
		`{"path":"/tmp/ws/gamma","name":"gamma-again","authorEmails":[]}` +
		`]}`
	rec := h.post("/api/collect/batch-add-sources", body)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	response := decodeBody(t, rec)
	if response["success"] != true {
		t.Fatalf("success = %v, want true", response["success"])
	}
	// alpha 已存在 → 跳过；gamma 第一次插入、第二次命中本次请求的已知集合 → 跳过。
	if response["addedCount"] != float64(1) {
		t.Fatalf("addedCount = %v, want 1", response["addedCount"])
	}

	rows := h.gitLocalRows(t)
	if len(rows) != 2 {
		t.Fatalf("git-local rows = %d, want 2 (seeded alpha + gamma)", len(rows))
	}
	if rows[1].Name != "gamma" {
		t.Fatalf("inserted name = %q, want gamma", rows[1].Name)
	}
}

// 部分失败：actions.ts 的循环没有事务，坏条目之前的插入会留在库里，响应仍是
// success:false + addedCount:0 + error（票面的 error 字段形状）。
func TestBatchAddSourcesReportsErrorShapeAfterPartialInsert(t *testing.T) {
	h := newHarness(t)

	body := `{"repos":[` +
		`{"path":"/tmp/ws/alpha","name":"alpha","authorEmails":[]},` +
		`{"path":"/tmp/ws/no-name","authorEmails":[]}` +
		`]}`
	rec := h.post("/api/collect/batch-add-sources", body)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	response := decodeBody(t, rec)
	if response["success"] != false {
		t.Fatalf("success = %v, want false", response["success"])
	}
	if response["addedCount"] != float64(0) {
		t.Fatalf("addedCount = %v, want 0", response["addedCount"])
	}
	if message, ok := response["error"].(string); !ok || message == "" {
		t.Fatalf("error = %v, want a non-empty string", response["error"])
	}

	// 第一条已落库：与 actions.ts 的无事务循环一致。
	if rows := h.gitLocalRows(t); len(rows) != 1 || rows[0].Name != "alpha" {
		t.Fatalf("rows after partial failure = %+v, want the first insert persisted", rows)
	}
}

func TestBatchAddSourcesReportsStorageErrors(t *testing.T) {
	h := newHarness(t)
	h.breakDB()

	rec := h.post("/api/collect/batch-add-sources", `{"repos":[{"path":"/tmp/ws/alpha","name":"alpha","authorEmails":[]}]}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	response := decodeBody(t, rec)
	if response["success"] != false {
		t.Fatalf("success = %v, want false", response["success"])
	}
	if response["addedCount"] != float64(0) {
		t.Fatalf("addedCount = %v, want 0", response["addedCount"])
	}
	if message, ok := response["error"].(string); !ok || message == "" {
		t.Fatalf("error = %v, want a non-empty string", response["error"])
	}
}

// 空列表是合法请求：什么都不做，回 success:true + addedCount:0。
func TestBatchAddSourcesAcceptsAnEmptyList(t *testing.T) {
	h := newHarness(t)

	rec := h.post("/api/collect/batch-add-sources", `{"repos":[]}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	response := decodeBody(t, rec)
	if response["success"] != true || response["addedCount"] != float64(0) {
		t.Fatalf("response = %v, want success true / addedCount 0", response)
	}
}

// 响应里 config 的 authorEmails 缺省时与 JSON.stringify 一致：键被省略
// （actions.ts 的 values 里 authorEmails: undefined）。
func TestBatchAddSourcesOmitsMissingAuthorEmails(t *testing.T) {
	h := newHarness(t)

	rec := h.post("/api/collect/batch-add-sources", `{"repos":[{"path":"/tmp/ws/alpha","name":"alpha"}]}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if message, ok := decodeBody(t, rec)["error"]; ok {
		t.Fatalf("unexpected error: %v", message)
	}

	rows := h.gitLocalRows(t)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal([]byte(rows[0].Config), &config); err != nil {
		t.Fatalf("config is not JSON: %s", rows[0].Config)
	}
	if _, ok := config["authorEmails"]; ok {
		t.Fatalf("authorEmails should be omitted: %s", rows[0].Config)
	}
	if string(config["owner"]) != `"/tmp/ws/alpha"` {
		t.Fatalf("owner = %s", config["owner"])
	}
	if strings.TrimSpace(string(config["branches"])) != "[]" {
		t.Fatalf("branches = %s, want []", config["branches"])
	}
}
