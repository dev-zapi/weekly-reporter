package events_test

import (
	"database/sql"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
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

// testPassword 与 B1 夹具同角色：密码请求 = 浏览器登录成功，且不写审计行。
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

// seedEvent 写一行 raw_events 并返回 id。metadata 为空串表示 NULL。
func (h *harness) seedEvent(content, source string, eventTimeSec int64, metadata string) int64 {
	h.t.Helper()

	var meta any
	if metadata != "" {
		meta = metadata
	}
	res, err := h.sqlDB.Exec(
		`INSERT INTO raw_events (event_time, source, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		eventTimeSec, source, content, meta, eventTimeSec, eventTimeSec,
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

func (h *harness) seedTag(eventID int64, tagName string) {
	h.t.Helper()
	if _, err := h.sqlDB.Exec(
		`INSERT INTO event_tags (event_id, tag_name, created_at) VALUES (?, ?, ?)`,
		eventID, tagName, int64(1_700_000_000),
	); err != nil {
		h.t.Fatalf("seed tag: %v", err)
	}
}

func (h *harness) seedSource(config string) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO collect_sources (type, name, config, created_at, updated_at) VALUES ('git-local', 'repo-a', ?, 0, 0)`,
		config,
	)
	if err != nil {
		h.t.Fatalf("seed source: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// seedPlanItem 建一条周期 + 计划项，供 comment_references 引用。
func (h *harness) seedPlanItem() int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO period_plans (scope, period_start, period_end, month_key, created_at, updated_at)
		 VALUES ('week', '2026-10-12', '2026-10-18', NULL, 0, 0)`,
	)
	if err != nil {
		h.t.Fatalf("seed plan: %v", err)
	}
	planID, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}

	res, err = h.sqlDB.Exec(
		`INSERT INTO period_plan_items (period_plan_id, text, position, created_at, updated_at) VALUES (?, 'Ship', 1, 0, 0)`,
		planID,
	)
	if err != nil {
		h.t.Fatalf("seed plan item: %v", err)
	}
	itemID, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return itemID
}

// citeComment 建一条计划项评论并把它的 @id 引用写进 comment_references。
func (h *harness) citeComment(planItemID, eventID int64) int64 {
	h.t.Helper()
	res, err := h.sqlDB.Exec(
		`INSERT INTO plan_item_comments (plan_item_id, content, author, created_at) VALUES (?, ?, NULL, 0)`,
		planItemID, "Cites @"+itoa(eventID),
	)
	if err != nil {
		h.t.Fatalf("seed comment: %v", err)
	}
	commentID, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.sqlDB.Exec(
		`INSERT INTO comment_references (comment_id, referenced_event_id, created_at) VALUES (?, ?, 0)`,
		commentID, eventID,
	); err != nil {
		h.t.Fatalf("seed comment reference: %v", err)
	}
	return commentID
}

func (h *harness) breakDB() {
	h.t.Helper()
	if err := h.sqlDB.Close(); err != nil {
		h.t.Fatalf("close db: %v", err)
	}
}

func (h *harness) tagNames(eventID int64) []string {
	h.t.Helper()
	rows, err := h.sqlDB.Query(`SELECT tag_name FROM event_tags WHERE event_id = ? ORDER BY tag_name`, eventID)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()

	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			h.t.Fatal(err)
		}
		names = append(names, name)
	}
	return names
}

// columnInts 读一列 int64，用于索引表断言。
func (h *harness) columnInts(t *testing.T, query string, args ...any) []int64 {
	t.Helper()
	rows, err := h.sqlDB.Query(query, args...)
	if err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	defer rows.Close()

	values := []int64{}
	for rows.Next() {
		var value int64
		if err := rows.Scan(&value); err != nil {
			t.Fatalf("scan %q: %v", query, err)
		}
		values = append(values, value)
	}
	return values
}

func (h *harness) countRows(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := h.sqlDB.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// expectedEndOfLocalDay 复刻 route.ts 的 `d.setHours(23, 59, 59, 999)`：取该时刻在
// 本地时区里的日历日，再设为当天最后一毫秒。周/日过滤依赖这条本地语义。
func expectedEndOfLocalDay(instant time.Time) time.Time {
	lt := instant.In(time.Local)
	return time.Date(lt.Year(), lt.Month(), lt.Day(), 23, 59, 59, 999*int(time.Millisecond), time.Local)
}

// jsSeconds 复刻 drizzle 的 timestamp 映射：Math.floor(ms/1000)。
func jsSeconds(t time.Time) int64 {
	return int64(math.Floor(float64(t.UnixMilli()) / 1000))
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}
