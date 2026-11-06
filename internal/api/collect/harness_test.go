package collect_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// testPassword 与 B1/B2/B3 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
const testPassword = "correct-password"

// fixtureTime 是所有夹具的固定时刻（Unix 秒），避免测试依赖当前时间。
const fixtureTime int64 = 1_760_000_000

// harness 装配生产的完整路由（api.NewRouter）：真实 SQLite（schema.sql 全量）+
// 真实中间件链 + 本域路由。挂载本身也是断言的一部分。
type harness struct {
	t      *testing.T
	router http.Handler
	sqlDB  *sql.DB
	conn   *db.Queries
	home   string
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

	// scan-path 与路径展开都以 $HOME 为基准；测试里把它指到临时目录，白名单与
	// 「相对路径解析到 HOME 下」两条语义才能被真实断言（HOME 也在白名单里）。
	home := t.TempDir()
	t.Setenv("HOME", home)

	return &harness{t: t, router: router, sqlDB: sqlDB, conn: conn, home: home}
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
	return h.doRequest(req)
}

func (h *harness) doRequest(req *http.Request) *httptest.ResponseRecorder {
	h.t.Helper()
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// sourceSeed 是 seedSource 的入参。
type sourceSeed struct {
	id             int64
	sourceType     string
	name           string
	config         string
	status         string
	projectScope   string
	lastSyncStatus *string
}

// seedSource 写一条 collect_sources 行并返回其 id。id 为 0 时用自增。
func (h *harness) seedSource(seed sourceSeed) int64 {
	h.t.Helper()

	status := seed.status
	if status == "" {
		status = "enabled"
	}
	scope := seed.projectScope
	if scope == "" {
		scope = "personal"
	}

	var res sql.Result
	var err error
	if seed.id != 0 {
		res, err = h.sqlDB.Exec(
			`INSERT INTO collect_sources (id, type, name, config, enabled, status, project_scope, last_sync_status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
			seed.id, seed.sourceType, seed.name, seed.config, status, scope, seed.lastSyncStatus, fixtureTime, fixtureTime,
		)
	} else {
		res, err = h.sqlDB.Exec(
			`INSERT INTO collect_sources (type, name, config, enabled, status, project_scope, last_sync_status, created_at, updated_at)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
			seed.sourceType, seed.name, seed.config, status, scope, seed.lastSyncStatus, fixtureTime, fixtureTime,
		)
	}
	if err != nil {
		h.t.Fatalf("seed source: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// sourceRow 读回一条 collect_sources（用于断言 config/status/last_sync_status 的写入）。
type sourceRow struct {
	sourceType     string
	status         *string
	lastSyncAt     *int64
	lastSyncStatus *string
	config         string
	updatedAt      int64
}

func (h *harness) source(id int64) sourceRow {
	h.t.Helper()

	var row sourceRow
	if err := h.sqlDB.QueryRow(
		`SELECT type, status, last_sync_at, last_sync_status, config, updated_at FROM collect_sources WHERE id = ?`, id,
	).Scan(&row.sourceType, &row.status, &row.lastSyncAt, &row.lastSyncStatus, &row.config, &row.updatedAt); err != nil {
		h.t.Fatalf("read source %d: %v", id, err)
	}
	return row
}

// events 读回全部 raw_events（按 id 升序）。
type eventRow struct {
	id        int64
	eventTime int64
	source    string
	content   string
	metadata  *string
	category  *string
	createdAt int64
	updatedAt int64
}

func (h *harness) events() []eventRow {
	h.t.Helper()

	rows, err := h.sqlDB.Query(
		`SELECT id, event_time, source, content, metadata, category, created_at, updated_at FROM raw_events ORDER BY id`)
	if err != nil {
		h.t.Fatalf("read events: %v", err)
	}
	defer rows.Close()

	var events []eventRow
	for rows.Next() {
		var row eventRow
		if err := rows.Scan(&row.id, &row.eventTime, &row.source, &row.content, &row.metadata,
			&row.category, &row.createdAt, &row.updatedAt); err != nil {
			h.t.Fatalf("scan event: %v", err)
		}
		events = append(events, row)
	}
	if err := rows.Err(); err != nil {
		h.t.Fatalf("iterate events: %v", err)
	}
	return events
}

// countRows 是通用行数查询。
func (h *harness) countRows(query string, args ...any) int {
	h.t.Helper()

	var n int
	if err := h.sqlDB.QueryRow(query, args...).Scan(&n); err != nil {
		h.t.Fatalf("count rows: %v", err)
	}
	return n
}

// breakDB 关掉底层连接，用来复现 route.ts 的 catch 分支（500 *_ERROR）。
func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

// gitFixture 是一个临时 git 仓库 fixture：真实 `git` 子进程执行，不 mock exec。
type gitFixture struct {
	t    *testing.T
	path string
}

// newGitFixture 在临时目录里 init 一个仓库，并把 user.email / user.name 固定成夹具值。
func newGitFixture(t *testing.T) *gitFixture {
	t.Helper()

	repo := t.TempDir()
	fixture := &gitFixture{t: t, path: repo}
	// 显式钉住分支名：夹具改了 HOME（scan-path 需要），git 的全局 init.defaultBranch
	// 配置因此不可用，默认分支会漂成 master。
	fixture.git("init", "--quiet", "--initial-branch=main")
	fixture.git("config", "user.email", fixtureEmail)
	fixture.git("config", "user.name", "Fixture Author")
	return fixture
}

// fixtureEmail 是夹具 commit 的 author email；采集源的 authorEmails 与之匹配。
const fixtureEmail = "fixture@example.com"

// git 执行一条 git 命令，失败即 Fatal。
func (f *gitFixture) git(args ...string) string {
	f.t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = f.path
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Fixture Author",
		"GIT_AUTHOR_EMAIL="+fixtureEmail,
		"GIT_COMMITTER_NAME=Fixture Author",
		"GIT_COMMITTER_EMAIL="+fixtureEmail,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// commit 写一个文件并提交，返回 commit sha。when 用固定时间，避免结果依赖当前时钟。
func (f *gitFixture) commit(message, when string) string {
	f.t.Helper()

	file := filepath.Join(f.path, strings.ReplaceAll(message, " ", "-")+".txt")
	if err := os.WriteFile(file, []byte(message+"\n"), 0o600); err != nil {
		f.t.Fatal(err)
	}
	f.git("add", ".")
	cmd := exec.Command("git", "commit", "--quiet", "-m", message)
	cmd.Dir = f.path
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Fixture Author",
		"GIT_AUTHOR_EMAIL="+fixtureEmail,
		"GIT_AUTHOR_DATE="+when,
		"GIT_COMMITTER_NAME=Fixture Author",
		"GIT_COMMITTER_EMAIL="+fixtureEmail,
		"GIT_COMMITTER_DATE="+when,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		f.t.Fatalf("git commit: %v\n%s", err, out)
	}
	return strings.TrimSpace(f.git("rev-parse", "HEAD"))
}

// configJSON 拼采集源 config（JSON 文本，与 drizzle 的 json mode 存法一致）。
func configJSON(owner string, extra string) string {
	config := `{"owner":` + strconv.Quote(owner) + `,"authorEmails":[` + strconv.Quote(fixtureEmail) + `]`
	if extra != "" {
		config += "," + extra
	}
	return config + "}"
}

// execGit 构造一个在 dir 下执行的 git 命令（调用方可自行设置 Env）。
func execGit(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd
}

// strconvQuote 拼 JSON 字符串字面量（测试里的 config 用）。
func strconvQuote(value string) string { return strconv.Quote(value) }

// relativeTime 返回 n 小时前的整秒时刻，供 fixture 的提交时间使用。
// 用相对时间而不是硬编码日期：同步会传 `--until=<now>`，写死未来日期会在
// 系统时钟不同步时把 commit 排除掉（测试变得依赖运行日期）。
func relativeTime(hoursAgo int) time.Time {
	return time.Now().Add(-time.Duration(hoursAgo) * time.Hour).Truncate(time.Second)
}

// gitDate 把时刻格式化成 git 的 `%ai` / `%ci` 形态（`YYYY-MM-DD HH:MM:SS ±HHMM`）。
func gitDate(t time.Time, zone *time.Location) string {
	return t.In(zone).Format("2006-01-02 15:04:05 -0700")
}

// isoCursor 是游标写入的 ISO 形态（toISOString）。
func isoCursor(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
