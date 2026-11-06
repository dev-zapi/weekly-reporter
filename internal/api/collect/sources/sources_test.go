package sources_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/collect/sources/route.test.ts 的 Go 同用例集（ADR-0029）：
// GET 的 3 条 syncStatus 用例与 POST 的 3 条 aliases 用例逐条对应。
//
// vitest 侧用 mock drizzle 断言生成的 SQL / 绑定参数，这里改成真库断言可观测结果
// （ADR-0029 的「同 happy path + 同 {error, code} 错误形状」）：syncStatus=failure
// 必须命中库里存的 failed、success 只命中 success；POST 必须把顶层 aliases 落进
// config.aliases、无 aliases 时不写该键、重复别名回 400 DUPLICATE_ALIAS。

type sourcesPage struct {
	Sources []struct {
		ID           int64           `json:"id"`
		Type         string          `json:"type"`
		Name         string          `json:"name"`
		Config       json.RawMessage `json:"config"`
		Enabled      bool            `json:"enabled"`
		Status       *string         `json:"status"`
		ProjectScope string          `json:"projectScope"`
		LastSyncAt   *string         `json:"lastSyncAt"`
	} `json:"sources"`
	Total    int64 `json:"total"`
	Page     any   `json:"page"`
	PageSize any   `json:"pageSize"`
}

func decodePage(t *testing.T, body []byte) sourcesPage {
	t.Helper()
	var page sourcesPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("decode sources page %s: %v", body, err)
	}
	return page
}

func decodeErrorCode(t *testing.T, body []byte) (string, string) {
	t.Helper()
	var payload struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode error body %s: %v", body, err)
	}
	return payload.Error, payload.Code
}

// TestListMatchesStoredFailedStatusWhenClientSendsFailure 对应 vitest 的第 1、2 条：
// syncStatus 的两种拼写（failure / failed）都要命中库里存的 failed。
func TestListMatchesStoredFailedStatusWhenClientSendsFailure(t *testing.T) {
	for _, syncStatus := range []string{"failure", "failed"} {
		t.Run(syncStatus, func(t *testing.T) {
			h := newHarness(t)
			failedID := h.seedSource("git-local", "failed-one", `{"owner":"/tmp/a"}`, withLastSync(1700000000, "failed"))
			h.seedSource("git-local", "success-one", `{"owner":"/tmp/b"}`, withLastSync(1700000000, "success"))
			h.seedSource("git-local", "never-one", `{"owner":"/tmp/c"}`, withNeverSynced())

			rec := h.doAuthed(http.MethodGet, "/api/collect/sources?syncStatus="+syncStatus, "")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			page := decodePage(t, rec.Body.Bytes())
			if len(page.Sources) != 1 || page.Sources[0].ID != failedID {
				t.Fatalf("sources = %+v, want only %d", page.Sources, failedID)
			}
			if page.Total != 1 {
				t.Fatalf("total = %d, want 1", page.Total)
			}
		})
	}
}

// TestListSuccessFilterOnlyMatchesSuccess 对应 vitest 的第 3 条：
// success 只匹配 last_sync_status = 'success'（never 与 failed 都不算）。
func TestListSuccessFilterOnlyMatchesSuccess(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-local", "failed-one", `{"owner":"/tmp/a"}`, withLastSync(1700000000, "failed"))
	successID := h.seedSource("git-local", "success-one", `{"owner":"/tmp/b"}`, withLastSync(1700000000, "success"))
	h.seedSource("git-local", "never-one", `{"owner":"/tmp/c"}`, withNeverSynced())

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources?syncStatus=success", "")
	page := decodePage(t, rec.Body.Bytes())
	if len(page.Sources) != 1 || page.Sources[0].ID != successID {
		t.Fatalf("sources = %+v, want only %d", page.Sources, successID)
	}
}

// TestListNeverFilterMatchesNullLastSync 补 syncStatus=never 的分支（route.ts 的
// `isNull(lastSyncAt)`）。
func TestListNeverFilterMatchesNullLastSync(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-local", "failed-one", `{"owner":"/tmp/a"}`, withLastSync(1700000000, "failed"))
	neverID := h.seedSource("git-local", "never-one", `{"owner":"/tmp/c"}`, withNeverSynced())

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources?syncStatus=never", "")
	page := decodePage(t, rec.Body.Bytes())
	if len(page.Sources) != 1 || page.Sources[0].ID != neverID {
		t.Fatalf("sources = %+v, want only %d", page.Sources, neverID)
	}
}

// TestListFilterByNameSearchesAliases 是 route.ts 里 json_each 别名搜索的等效用例。
func TestListFilterByNameSearchesAliases(t *testing.T) {
	h := newHarness(t)
	aliasID := h.seedSource("git-local", "plain-name", `{"owner":"/tmp/a","aliases":["alpha-repo"]}`)
	h.seedSource("git-local", "other", `{"owner":"/tmp/b","aliases":["beta"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources?name=alpha", "")
	page := decodePage(t, rec.Body.Bytes())
	if len(page.Sources) != 1 || page.Sources[0].ID != aliasID {
		t.Fatalf("sources = %+v, want only %d", page.Sources, aliasID)
	}
}

// TestListPaginatesAndReportsTotal 覆盖 limit/offset/total 与响应里的 page/pageSize。
func TestListPaginatesAndReportsTotal(t *testing.T) {
	h := newHarness(t)
	for _, name := range []string{"aa", "bb", "cc"} {
		h.seedSource("git-local", name, `{"owner":"/tmp/`+name+`"}`)
	}

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources?page=2&pageSize=2&sortBy=name&sortOrder=asc", "")
	page := decodePage(t, rec.Body.Bytes())
	if len(page.Sources) != 1 || page.Sources[0].Name != "cc" {
		t.Fatalf("sources = %+v, want the single 'cc' row", page.Sources)
	}
	if page.Total != 3 {
		t.Fatalf("total = %d, want 3", page.Total)
	}
	if page.Page != float64(2) || page.PageSize != float64(2) {
		t.Fatalf("page/pageSize = %v/%v, want 2/2", page.Page, page.PageSize)
	}
}

// TestListMasksStoredToken 复刻 `config: {...config, token: '[ENCRYPTED]'}`。
func TestListMasksStoredToken(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-remote-github", "remote", `{"owner":"org","repo":"repo","token":"secret","authorEmails":["a@b.c"]}`)

	rec := h.doAuthed(http.MethodGet, "/api/collect/sources", "")
	page := decodePage(t, rec.Body.Bytes())
	if len(page.Sources) != 1 {
		t.Fatalf("sources = %+v", page.Sources)
	}
	var config map[string]any
	if err := json.Unmarshal(page.Sources[0].Config, &config); err != nil {
		t.Fatalf("decode config %s: %v", page.Sources[0].Config, err)
	}
	if config["token"] != "[ENCRYPTED]" {
		t.Fatalf("token = %v, want [ENCRYPTED]", config["token"])
	}
}

// TestCreatePersistsTopLevelAliases 对应 vitest 的第 1 条 POST 用例：
// 顶层 aliases 必须落进 config.aliases（回归：曾经被静默丢弃）。
func TestCreatePersistsTopLevelAliases(t *testing.T) {
	h := newHarness(t)

	body := `{"type":"git-local","name":"alpha","projectScope":"personal","aliases":["ax"],"config":{"owner":"/tmp/alpha","authorEmails":["dev@example.com"]}}`
	rec := h.doAuthed(http.MethodPost, "/api/collect/sources", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var created struct {
		ID     int64           `json:"id"`
		Config json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created %s: %v", rec.Body.Bytes(), err)
	}
	var config map[string]any
	if err := json.Unmarshal(created.Config, &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	aliases, _ := config["aliases"].([]any)
	if len(aliases) != 1 || aliases[0] != "ax" {
		t.Fatalf("config.aliases = %v, want [ax]", config["aliases"])
	}

	stored := h.load(created.ID)
	if !strings.Contains(stored.Config, `"aliases":["ax"]`) {
		t.Fatalf("stored config = %s", stored.Config)
	}
	// git-local 的 owner 走 expandInputPath + stripTrailingSlash。
	if !strings.Contains(stored.Config, `"owner":"/tmp/alpha"`) {
		t.Fatalf("stored config = %s", stored.Config)
	}
	if stored.Status == nil || *stored.Status != "enabled" {
		t.Fatalf("status = %v, want enabled", stored.Status)
	}
}

// TestCreateOmitsAliasesKeyWhenBodyHasNone 对应 vitest 的第 2 条 POST 用例。
func TestCreateOmitsAliasesKeyWhenBodyHasNone(t *testing.T) {
	h := newHarness(t)

	body := `{"type":"git-local","name":"beta","projectScope":"work","config":{"owner":"/tmp/beta","authorEmails":["dev@example.com"]}}`
	rec := h.doAuthed(http.MethodPost, "/api/collect/sources", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var created struct {
		ID     int64           `json:"id"`
		Config json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	var config map[string]any
	if err := json.Unmarshal(created.Config, &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if _, present := config["aliases"]; present {
		t.Fatalf("config.aliases present: %v", config)
	}
	if strings.Contains(h.load(created.ID).Config, "aliases") {
		t.Fatalf("stored config carries aliases: %s", h.load(created.ID).Config)
	}
}

// TestCreateRejectsDuplicateAlias 对应 vitest 的第 3 条 POST 用例。
func TestCreateRejectsDuplicateAlias(t *testing.T) {
	h := newHarness(t)
	h.seedSource("git-local", "other", `{"owner":"/tmp/other","aliases":["ax"]}`)

	body := `{"type":"git-local","name":"alpha","projectScope":"personal","aliases":["ax"],"config":{"owner":"/tmp/alpha","authorEmails":["dev@example.com"]}}`
	rec := h.doAuthed(http.MethodPost, "/api/collect/sources", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	message, code := decodeErrorCode(t, rec.Body.Bytes())
	if code != "DUPLICATE_ALIAS" {
		t.Fatalf("code = %q, body %s", code, rec.Body.String())
	}
	if message != "别名已被使用: ax" {
		t.Fatalf("error = %q", message)
	}

	var count int64
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM collect_sources`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1 (insert must not happen)", count)
	}
}

// TestCreateReturnsValidationIssues 补 zod 失败形状（route.ts 的 VALIDATION_ERROR）。
func TestCreateReturnsValidationIssues(t *testing.T) {
	h := newHarness(t)

	rec := h.doAuthed(http.MethodPost, "/api/collect/sources", `{"type":"nope"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Details struct {
			Issues []struct {
				Path    string `json:"path"`
				Message string `json:"message"`
			} `json:"issues"`
		} `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Error != "数据验证失败" || payload.Code != "VALIDATION_ERROR" {
		t.Fatalf("payload = %+v", payload)
	}
	gotPaths := make([]string, 0, len(payload.Details.Issues))
	for _, issue := range payload.Details.Issues {
		gotPaths = append(gotPaths, issue.Path)
	}
	want := []string{"type", "name", "projectScope", "config"}
	if strings.Join(gotPaths, ",") != strings.Join(want, ",") {
		t.Fatalf("issue paths = %v, want %v", gotPaths, want)
	}
}

// TestCreateDerivesDisabledStatus 覆盖 route.ts 的状态推导里可达的 disabled 分支。
//
// unavailable 分支在 zod 之后不可达：authorEmails 至少有 1 项（min(1)），
// 所以 `hasEmails` 恒真。这里只断言 enabled=false 这个真实可达的分支。
func TestCreateDerivesDisabledStatus(t *testing.T) {
	h := newHarness(t)

	body := `{"type":"git-local","name":"gamma","projectScope":"work","enabled":false,"config":{"owner":"/tmp/gamma","authorEmails":["a@b.c"]}}`
	rec := h.doAuthed(http.MethodPost, "/api/collect/sources", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID      int64   `json:"id"`
		Status  *string `json:"status"`
		Enabled bool    `json:"enabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Status == nil || *created.Status != "disabled" {
		t.Fatalf("status = %v, want disabled", created.Status)
	}
	if created.Enabled {
		t.Fatalf("enabled = true, want false")
	}
}
