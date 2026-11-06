package collect_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 本文件覆盖 /api/collect/git-remote/sync：route.ts 无既有 vitest，按票面新写
// httptest。git 面一律用真实临时仓库 fixture（exec git），不 mock。

func syncBody(sourceID int64, resync bool) string {
	if resync {
		return `{"sourceId":` + itoa(sourceID) + `,"resync":true}`
	}
	return `{"sourceId":` + itoa(sourceID) + `}`
}

func TestGitRemoteSyncRejectsInvalidSourceID(t *testing.T) {
	h := newHarness(t)

	for _, body := range []string{`{"sourceId":"abc"}`, `{"sourceId":true}`} {
		t.Run(body, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", body, testPassword)
			status, decoded := decode(t, rec)
			if status != http.StatusBadRequest || decoded["code"] != "INVALID_ID" {
				t.Fatalf("status = %d, body = %v", status, decoded)
			}
		})
	}
}

// 数字形态与数字字符串都能 parseInt：`12abc` 在 JS 里也是 12。
func TestGitRemoteSyncParsesSourceIDLikeParseInt(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource(sourceSeed{
		sourceType: "git-remote-github",
		name:       "GitHub",
		config:     `{"owner":"o","repo":"r","token":"t","authorEmails":["a@b.c"]}`,
	})

	cases := []string{
		`{"sourceId":` + itoa(id) + `}`,
		`{"sourceId":"` + itoa(id) + `"}`,
		`{"sourceId":"` + itoa(id) + `abc"}`,
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			// 远端 API 不可达不是本用例的关注点：只要请求体被解析成同一个 id，
			// 就不会落 400；它会在同步失败分支回 500 SYNC_FAILED。
			rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", body, testPassword)
			status, decoded := decode(t, rec)
			if status != http.StatusInternalServerError || decoded["code"] != "SYNC_FAILED" {
				t.Fatalf("status = %d, body = %v", status, decoded)
			}
		})
	}
}

func TestGitRemoteSyncUnknownSourceFails(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", `{"sourceId":999}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	if result["error"] != "采集源不存在" || result["status"] != "failed" {
		t.Fatalf("result = %v", result)
	}
	if result["sourceName"] != "" {
		t.Fatalf("sourceName = %v", result["sourceName"])
	}
}

func TestGitRemoteSyncDisabledSourceFails(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "禁用源",
		config:     configJSON(t.TempDir(), ""),
		status:     "disabled",
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	if result["error"] != "采集源已禁用" {
		t.Fatalf("error = %v", result["error"])
	}
	// failedResult 里没有 branches 键。
	if _, present := result["branches"]; present {
		t.Fatalf("failure result must omit branches: %v", result)
	}
}

// 未配置邮箱的采集源会被标记 unavailable，并带 autoDisabled=true。
func TestGitRemoteSyncWithoutAuthorEmailsMarksUnavailable(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "无邮箱",
		config:     `{"owner":"` + t.TempDir() + `","authorEmails":[]}`,
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	if result["error"] != "未配置邮箱" || result["autoDisabled"] != true {
		t.Fatalf("result = %v", result)
	}
	row := h.source(id)
	if row.status == nil || *row.status != "unavailable" {
		t.Fatalf("status = %v, want unavailable", row.status)
	}
	if row.lastSyncStatus != nil {
		t.Fatalf("lastSyncStatus = %v, want unchanged", *row.lastSyncStatus)
	}
}

func TestGitRemoteSyncUnsupportedTypeFails(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource(sourceSeed{
		sourceType: "git-remote-bitbucket",
		name:       "Bitbucket",
		config:     `{"owner":"o","authorEmails":["a@b.c"]}`,
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if nested(t, body, "result")["error"] != "不支持的采集源类型" {
		t.Fatalf("result = %v", body["result"])
	}
}

// 显式分支模式：采集 main 上的 commit，写入事件并更新该分支游标。
func TestGitRemoteSyncExplicitBranchCollectsCommits(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	authored := relativeTime(48)
	commitSha := repo.commit("feat: first", gitDate(authored, time.FixedZone("UTC+8", 8*3600)))

	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "显式分支",
		config:     configJSON(repo.path, `"branches":["main"]`),
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	if result["status"] != "success" {
		t.Fatalf("result = %v", result)
	}
	if result["commitsCount"] != float64(1) || result["eventsCount"] != float64(1) {
		t.Fatalf("counts = %v", result)
	}

	// 成功结果一定带 branches 数组（sync.ts 的对象字面量里恒有该键）。
	branches, present := result["branches"].([]any)
	if !present || len(branches) != 1 {
		t.Fatalf("branches = %v", result["branches"])
	}
	branchResult := branches[0].(map[string]any)
	if branchResult["name"] != "main" || branchResult["status"] != "success" || branchResult["commitsCount"] != float64(1) {
		t.Fatalf("branch result = %v", branchResult)
	}

	events := h.events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	event := events[0]
	if event.source != "git-local" || event.content != "feat: first" {
		t.Fatalf("event = %+v", event)
	}
	// author date → event_time（drizzle 的 timestamp 列存 Unix 秒）。
	if event.eventTime != authored.Unix() {
		t.Fatalf("eventTime = %d, want %d", event.eventTime, authored.Unix())
	}
	if event.category == nil || *event.category != "核心开发" {
		t.Fatalf("category = %v", event.category)
	}
	metadata := metadataMap(t, event.metadata)
	if metadata["sha"] != commitSha {
		t.Fatalf("sha = %v, want %s", metadata["sha"], commitSha)
	}
	if metadata["branch"] != "main" {
		t.Fatalf("branch = %v", metadata["branch"])
	}
	if metadata["sourceId"] != float64(id) {
		t.Fatalf("sourceId = %v", metadata["sourceId"])
	}
	if metadata["url"] != "" {
		t.Fatalf("url = %v, want empty string", metadata["url"])
	}

	row := h.source(id)
	if row.lastSyncStatus == nil || *row.lastSyncStatus != "success" {
		t.Fatalf("lastSyncStatus = %v", row.lastSyncStatus)
	}
	if row.lastSyncAt == nil {
		t.Fatalf("lastSyncAt is NULL")
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(row.config), &config); err != nil {
		t.Fatalf("config is not JSON: %v", err)
	}
	branches, ok := config["branches"].([]any)
	if !ok || len(branches) != 1 {
		t.Fatalf("branches = %v", config["branches"])
	}
	branch := branches[0].(map[string]any)
	if branch["name"] != "main" || branch["lastCommitTime"] != isoCursor(authored) {
		t.Fatalf("branch = %v", branch)
	}
}

// 全分支模式（git-local 且 branches 为空）：采集所有本地 head，按「当前分支优先、
// 其余字母序」归属 metadata.branch，并写 config.branchCursors。
func TestGitRemoteSyncAllBranchesAttributionAndCursors(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	zone := time.FixedZone("UTC+8", 8*3600)
	mainAuthored := relativeTime(72)
	featureAuthored := relativeTime(48)
	mainSha := repo.commit("feat: main", gitDate(mainAuthored, zone))
	repo.git("branch", "feature")
	repo.git("checkout", "--quiet", "feature")
	featureSha := repo.commit("feat: feature", gitDate(featureAuthored, zone))
	repo.git("checkout", "--quiet", "main")

	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "全分支",
		config:     configJSON(repo.path, ""),
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	if result["status"] != "success" || result["eventsCount"] != float64(2) {
		t.Fatalf("result = %v", result)
	}

	bySha := map[string]map[string]any{}
	for _, event := range h.events() {
		metadata := metadataMap(t, event.metadata)
		sha, _ := metadata["sha"].(string)
		bySha[sha] = metadata
	}
	if bySha[mainSha]["branch"] != "main" {
		t.Fatalf("main commit branch = %v", bySha[mainSha]["branch"])
	}
	if bySha[featureSha]["branch"] != "feature" {
		t.Fatalf("feature commit branch = %v", bySha[featureSha]["branch"])
	}

	row := h.source(id)
	var config map[string]any
	if err := json.Unmarshal([]byte(row.config), &config); err != nil {
		t.Fatalf("config is not JSON: %v", err)
	}
	cursors, ok := config["branchCursors"].([]any)
	if !ok || len(cursors) != 2 {
		t.Fatalf("branchCursors = %v", config["branchCursors"])
	}
	cursorByName := map[string]any{}
	for _, raw := range cursors {
		cursor := raw.(map[string]any)
		cursorByName[cursor["name"].(string)] = cursor["lastCommitTime"]
	}
	if cursorByName["main"] != isoCursor(mainAuthored) {
		t.Fatalf("main cursor = %v, want %s", cursorByName["main"], isoCursor(mainAuthored))
	}
	if cursorByName["feature"] != isoCursor(featureAuthored) {
		t.Fatalf("feature cursor = %v, want %s", cursorByName["feature"], isoCursor(featureAuthored))
	}
	// config.branches 必须保持「空配置 = 全分支」的意图。
	if rawBranches, present := config["branches"]; present && rawBranches != nil {
		if entries, ok := rawBranches.([]any); !ok || len(entries) != 0 {
			t.Fatalf("branches = %v, want empty/absent", rawBranches)
		}
	}
}

// 重复同步不重复插入事件（sourceId + sha 去重）。
func TestGitRemoteSyncDeduplicatesBySha(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	repo.commit("feat: first", gitDate(relativeTime(48), time.UTC))

	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "去重",
		config:     configJSON(repo.path, `"branches":["main"]`),
	})

	for i := 0; i < 2; i++ {
		rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, true), testPassword)
		status, body := decode(t, rec)
		if status != http.StatusOK {
			t.Fatalf("sync %d: status = %d, body = %v", i, status, body)
		}
	}

	if got := h.countRows(`SELECT COUNT(*) FROM raw_events`); got != 1 {
		t.Fatalf("events = %d, want 1", got)
	}
}

// 作者邮箱过滤：不匹配的 commit 不进事件。
func TestGitRemoteSyncFiltersByAuthorEmail(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	repo.commit("feat: tracked", gitDate(relativeTime(72), time.UTC))

	file := filepath.Join(repo.path, "other.txt")
	if err := os.WriteFile(file, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo.git("add", ".")
	commitCmd := execGit(repo.path, "commit", "--quiet", "-m", "feat: other author")
	commitCmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Other", "GIT_AUTHOR_EMAIL=other@example.com",
		"GIT_AUTHOR_DATE="+gitDate(relativeTime(48), time.UTC),
		"GIT_COMMITTER_NAME=Other", "GIT_COMMITTER_EMAIL=other@example.com",
		"GIT_COMMITTER_DATE="+gitDate(relativeTime(48), time.UTC),
	)
	if out, err := commitCmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}

	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "作者过滤",
		config:     configJSON(repo.path, `"branches":["main"]`),
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)
	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if nested(t, body, "result")["eventsCount"] != float64(1) {
		t.Fatalf("result = %v", body["result"])
	}
	for _, event := range h.events() {
		if event.content != "feat: tracked" {
			t.Fatalf("unexpected event: %+v", event)
		}
	}
}

// 路径不存在 → 采集源标记 unavailable（autoDisabled=true），outer catch 生效。
func TestGitRemoteSyncMissingRepoMarksUnavailable(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "路径不存在",
		config:     configJSON(filepath.Join(t.TempDir(), "missing"), ""),
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	if result["autoDisabled"] != true {
		t.Fatalf("result = %v", result)
	}
	if !strings.HasPrefix(result["error"].(string), "本地仓库路径不存在：") {
		t.Fatalf("error = %v", result["error"])
	}
	row := h.source(id)
	if row.status == nil || *row.status != "unavailable" {
		t.Fatalf("status = %v", row.status)
	}
	if row.lastSyncStatus == nil || *row.lastSyncStatus != "failed" {
		t.Fatalf("lastSyncStatus = %v", row.lastSyncStatus)
	}
}

// 旧 paths 模型迁移：branchNames 来自 paths[].lastBranch，paths 键被移除。
func TestGitRemoteSyncMigratesLegacyPaths(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	repo.commit("feat: first", gitDate(relativeTime(48), time.UTC))

	legacyConfig := `{"owner":` + strconvQuote(repo.path) + `,"authorEmails":[` + strconvQuote(fixtureEmail) + `],` +
		`"paths":[{"path":"ignored","lastBranch":"main"},{"path":"ignored2","lastBranch":"main"}]}`
	id := h.seedSource(sourceSeed{sourceType: "git-local", name: "旧配置", config: legacyConfig})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)
	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}

	row := h.source(id)
	var config map[string]any
	if err := json.Unmarshal([]byte(row.config), &config); err != nil {
		t.Fatalf("config is not JSON: %v", err)
	}
	if _, present := config["paths"]; present {
		t.Fatalf("paths key still present: %v", config)
	}
	branches, ok := config["branches"].([]any)
	if !ok || len(branches) != 1 {
		t.Fatalf("branches = %v", config["branches"])
	}
	if branches[0].(map[string]any)["name"] != "main" {
		t.Fatalf("branches = %v", branches)
	}
}

// 全量同步：只同步 enabled 且有邮箱的来源；有失败项回 500 PARTIAL_SYNC_FAILED。
func TestGitRemoteSyncAllSourcesPartialFailure(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	repo.commit("feat: ok", gitDate(relativeTime(48), time.UTC))

	okID := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "正常",
		config:     configJSON(repo.path, `"branches":["main"]`),
	})
	badID := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "失败",
		config:     configJSON(filepath.Join(t.TempDir(), "missing"), ""),
	})
	// 无邮箱的来源在全量同步里被跳过（不产生 unavailable 写入）。
	noEmailID := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "无邮箱",
		config:     `{"owner":"` + repo.path + `","authorEmails":[]}`,
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", `{}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "PARTIAL_SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if body["failedCount"] != float64(1) {
		t.Fatalf("failedCount = %v", body["failedCount"])
	}
	results, ok := body["results"].([]any)
	if !ok || len(results) != 2 {
		t.Fatalf("results = %v", body["results"])
	}
	statuses := map[float64]any{}
	for _, raw := range results {
		result := raw.(map[string]any)
		statuses[result["sourceId"].(float64)] = result["status"]
	}
	if statuses[float64(okID)] != "success" || statuses[float64(badID)] != "failed" {
		t.Fatalf("statuses = %v", statuses)
	}
	if row := h.source(noEmailID); row.status == nil || *row.status != "enabled" {
		t.Fatalf("no-email source status = %v, want untouched", row.status)
	}
}

func TestGitRemoteSyncAllSourcesSuccess(t *testing.T) {
	h := newHarness(t)
	repo := newGitFixture(t)
	repo.commit("feat: ok", gitDate(relativeTime(48), time.UTC))

	id := h.seedSource(sourceSeed{
		sourceType: "git-local",
		name:       "正常",
		config:     configJSON(repo.path, `"branches":["main"]`),
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", `{}`, testPassword)

	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	results, ok := body["results"].([]any)
	if !ok || len(results) != 1 {
		t.Fatalf("results = %v", body["results"])
	}
	result := results[0].(map[string]any)
	if result["sourceId"] != float64(id) || result["status"] != "success" {
		t.Fatalf("result = %v", result)
	}
}

// 远端适配器：baseUrl 指向本地假 API，验证请求路径/鉴权头与事件落库。
func TestGitRemoteSyncGithubAdapter(t *testing.T) {
	h := newHarness(t)

	type seenRequest struct {
		path   string
		query  string
		auth   string
		accept string
	}
	authored := relativeTime(24).UTC()
	requests := make(chan seenRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- seenRequest{
			path:   r.URL.Path,
			query:  r.URL.RawQuery,
			auth:   r.Header.Get("Authorization"),
			accept: r.Header.Get("Accept"),
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
		  {"sha":"aaa","html_url":"https://example.test/commit/aaa","commit":{"message":"feat: remote\n\nbody","author":{"date":"` + authored.Format(time.RFC3339) + `","email":"tracked@example.com","name":"Tracked"},"committer":{"date":"` + authored.Format(time.RFC3339) + `"}}},
		  {"sha":"bbb","html_url":"https://example.test/commit/bbb","commit":{"message":"chore: other","author":{"date":"2026-01-04T02:00:00Z","email":"other@example.com","name":"Other"},"committer":{"date":"2026-01-04T03:00:00Z"}}}
		]`))
	}))
	defer server.Close()

	id := h.seedSource(sourceSeed{
		sourceType: "git-remote-github",
		name:       "远端",
		config: `{"baseUrl":` + strconvQuote(server.URL) + `,"owner":"acme","repo":"widgets",` +
			`"token":"secret-token","authorEmails":["tracked@example.com"],"branches":["dev"]}`,
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)

	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if nested(t, body, "result")["eventsCount"] != float64(1) {
		t.Fatalf("result = %v", body["result"])
	}

	select {
	case request := <-requests:
		if request.path != "/repos/acme/widgets/commits" {
			t.Fatalf("path = %s", request.path)
		}
		if !strings.Contains(request.query, "per_page=100") || !strings.Contains(request.query, "sha=dev") {
			t.Fatalf("query = %s", request.query)
		}
		if request.auth != "Bearer secret-token" || request.accept != "application/vnd.github.v3+json" {
			t.Fatalf("headers = %+v", request)
		}
	default:
		t.Fatalf("upstream API was not called")
	}

	events := h.events()
	if len(events) != 1 {
		t.Fatalf("events = %d", len(events))
	}
	if events[0].source != "git-remote-github" || events[0].content != "feat: remote" {
		t.Fatalf("event = %+v", events[0])
	}
	if events[0].eventTime != authored.Unix() {
		t.Fatalf("eventTime = %d, want %d", events[0].eventTime, authored.Unix())
	}
	metadata := metadataMap(t, events[0].metadata)
	// normalizeRepoName("acme/widgets") 去掉 host 段后只剩 repo 名（route.ts 同义）。
	if metadata["url"] != "https://example.test/commit/aaa" || metadata["repo"] != "widgets" {
		t.Fatalf("metadata = %v", metadata)
	}
}

func TestGitRemoteSyncGithubAdapterMapsErrors(t *testing.T) {
	h := newHarness(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	id := h.seedSource(sourceSeed{
		sourceType: "git-remote-github",
		name:       "远端",
		config: `{"baseUrl":` + strconvQuote(server.URL) + `,"owner":"acme","repo":"widgets",` +
			`"token":"secret-token","authorEmails":["tracked@example.com"],"branches":["dev"]}`,
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)
	status, body := decode(t, rec)
	if status != http.StatusInternalServerError || body["code"] != "SYNC_FAILED" {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	result := nested(t, body, "result")
	want := "全部分支同步失败：仓库不存在或无权限访问: acme/widgets"
	if result["error"] != want {
		t.Fatalf("error = %v, want %q", result["error"], want)
	}
	// 全部分支失败走的是 failedResult 的默认分支（没传 autoDisabled），键不出现。
	if _, present := result["autoDisabled"]; present {
		t.Fatalf("autoDisabled should be absent: %v", result)
	}
	if row := h.source(id); row.lastSyncStatus == nil || *row.lastSyncStatus != "failed" {
		t.Fatalf("lastSyncStatus = %v", row.lastSyncStatus)
	}
}

func TestGitRemoteSyncGitlabAdapter(t *testing.T) {
	h := newHarness(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// project id 按 encodeURIComponent 编码：`acme%2Fwidgets`。服务端拿到的是
		// 解码后的 Path，所以断言原始请求行。
		if r.URL.EscapedPath() != "/projects/acme%2Fwidgets/repository/commits" {
			t.Errorf("path = %s", r.URL.EscapedPath())
		}
		if r.Header.Get("PRIVATE-TOKEN") != "gl-token" {
			t.Errorf("PRIVATE-TOKEN = %q", r.Header.Get("PRIVATE-TOKEN"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
		  {"id":"ccc","message":"feat: gitlab","authored_date":"` + relativeTime(24).UTC().Format(time.RFC3339) + `","committed_date":"` + relativeTime(24).UTC().Format(time.RFC3339) + `","author_email":"tracked@example.com","author_name":"Tracked","web_url":"https://gitlab.test/commit/ccc"}
		]`))
	}))
	defer server.Close()

	id := h.seedSource(sourceSeed{
		sourceType: "git-remote-gitlab",
		name:       "GitLab",
		config: `{"baseUrl":` + strconvQuote(server.URL) + `,"owner":"acme","repo":"widgets",` +
			`"token":"gl-token","authorEmails":["tracked@example.com"],"branches":["main"]}`,
	})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), testPassword)
	status, body := decode(t, rec)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if nested(t, body, "result")["eventsCount"] != float64(1) {
		t.Fatalf("result = %v", body["result"])
	}
	metadata := metadataMap(t, h.events()[0].metadata)
	if metadata["url"] != "https://gitlab.test/commit/ccc" {
		t.Fatalf("metadata = %v", metadata)
	}
}

func TestGitRemoteSyncRejectsMalformedBody(t *testing.T) {
	h := newHarness(t)

	for _, body := range []string{`{`, `null`} {
		t.Run(body, func(t *testing.T) {
			rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", body, testPassword)
			status, decoded := decode(t, rec)
			if status != http.StatusInternalServerError || decoded["code"] != "SYNC_ERROR" {
				t.Fatalf("status = %d, body = %v", status, decoded)
			}
			if decoded["error"] != "同步失败" {
				t.Fatalf("error = %v", decoded["error"])
			}
		})
	}
}

func TestGitRemoteSyncRequiresAuth(t *testing.T) {
	h := newHarness(t)
	id := h.seedSource(sourceSeed{sourceType: "git-local", name: "本地", config: configJSON(t.TempDir(), "")})

	rec := h.do(http.MethodPost, "/api/collect/git-remote/sync", syncBody(id, false), "")

	status, body := decode(t, rec)
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %v", status, body)
	}
}

// metadataMap 解 raw_events.metadata。
func metadataMap(t *testing.T, raw *string) map[string]any {
	t.Helper()
	if raw == nil {
		t.Fatalf("metadata is NULL")
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(*raw), &metadata); err != nil {
		t.Fatalf("metadata is not JSON: %v", err)
	}
	return metadata
}
