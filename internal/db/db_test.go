package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// openTestDB 打开一个临时库并套用签入的 schema.sql。用真实文件而不是 :memory:，
// 这样 DSN 的 pragma 也一起被验证（:memory: 每连接一个库，会掩盖连接参数问题）。
func openTestDB(t *testing.T) (*sql.DB, *Queries) {
	t.Helper()
	conn, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	raw, err := os.ReadFile("schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range strings.Split(string(raw), ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatalf("apply schema: %v\n%s", err, stmt)
		}
	}
	return conn, New(conn)
}

func TestOpenAppliesBetterSQLiteDefaults(t *testing.T) {
	conn, _ := openTestDB(t)

	var foreignKeys int
	if err := conn.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d, want 1", foreignKeys)
	}

	var busyTimeout int
	if err := conn.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if busyTimeout != 5000 {
		t.Fatalf("busy_timeout = %d, want 5000", busyTimeout)
	}
}

func TestTimestampsStayInt64Seconds(t *testing.T) {
	ctx := context.Background()
	_, q := openTestDB(t)

	const createdAt int64 = 1_700_000_000 // Unix 秒，不是毫秒
	report, err := q.InsertReport(ctx, InsertReportParams{
		Title:           "week",
		Content:         "content",
		WeekStart:       "2026-11-02",
		WeekEnd:         "2026-11-08",
		AiStyleOverride: nil,
		CreatedAt:       createdAt,
		UpdatedAt:       createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.CreatedAt != createdAt {
		t.Fatalf("created_at = %d, want %d (seconds must survive untouched)", report.CreatedAt, createdAt)
	}
}

func TestNullableJSONColumnsScanAsPointer(t *testing.T) {
	ctx := context.Background()
	_, q := openTestDB(t)

	// NULL 行：*json.RawMessage 必须是 nil 而不是 Scan 错误（研究文档 §2.7 的坑）。
	nullEvent, err := q.InsertRawEvent(ctx, InsertRawEventParams{
		EventTime: 1_700_000_000,
		Source:    "git-local",
		Content:   "no metadata",
		Metadata:  nil,
		Category:  nil,
		CreatedAt: 1_700_000_000,
		UpdatedAt: 1_700_000_000,
	})
	if err != nil {
		t.Fatalf("NULL metadata must scan cleanly: %v", err)
	}
	if nullEvent.Metadata != nil {
		t.Fatalf("metadata = %s, want nil", *nullEvent.Metadata)
	}

	payload := json.RawMessage(`{"sha":"abc"}`)
	event, err := q.InsertRawEvent(ctx, InsertRawEventParams{
		EventTime: 1_700_000_001,
		Source:    "git-local",
		Content:   "with metadata",
		Metadata:  &payload,
		CreatedAt: 1_700_000_001,
		UpdatedAt: 1_700_000_001,
	})
	if err != nil {
		t.Fatal(err)
	}
	if event.Metadata == nil || string(*event.Metadata) != `{"sha":"abc"}` {
		t.Fatalf("metadata = %v", event.Metadata)
	}

	events, err := q.ListRecentRawEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}
	if events[0].Metadata == nil || events[0].CreatedAt != 1_700_000_001 {
		t.Fatalf("newest row = %+v", events[0])
	}
	if events[1].Metadata != nil {
		t.Fatalf("oldest row metadata = %v, want nil", events[1].Metadata)
	}
}

func TestUpsertAndExecrowsSemantics(t *testing.T) {
	ctx := context.Background()
	conn, q := openTestDB(t)

	// ON CONFLICT DO NOTHING：同键第二次插入是 no-op 而不是错误。
	for i := 0; i < 2; i++ {
		if err := q.InsertEventTag(ctx, InsertEventTagParams{
			EventID:   1,
			TagName:   "debug",
			CreatedAt: 1_700_000_000,
		}); err != nil {
			t.Fatalf("insert #%d: %v", i, err)
		}
	}
	var tagCount int
	if err := conn.QueryRow("SELECT COUNT(*) FROM event_tags").Scan(&tagCount); err != nil {
		t.Fatal(err)
	}
	if tagCount != 1 {
		t.Fatalf("event_tags rows = %d, want 1", tagCount)
	}

	// :execrows 返回受影响行数，调用方靠它判断「是否命中一行」。
	rows, err := q.TouchAPIToken(ctx, TouchAPITokenParams{LastUsedAt: ptr(int64(1_700_000_000_000)), ID: 42})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("rows affected = %d, want 0 for a missing token", rows)
	}

	if _, err := conn.Exec(
		"INSERT INTO api_tokens (id, name, token_hash, prefix, created_at) VALUES (42, 'agent', 'hash', 'wrp_', 0)",
	); err != nil {
		t.Fatal(err)
	}
	rows, err = q.TouchAPIToken(ctx, TouchAPITokenParams{LastUsedAt: ptr(int64(1_700_000_000_000)), ID: 42})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("rows affected = %d, want 1", rows)
	}
}

func TestNativeJSONEachQuery(t *testing.T) {
	ctx := context.Background()
	conn, q := openTestDB(t)

	if _, err := conn.Exec(
		`INSERT INTO collect_sources (id, type, name, config, created_at, updated_at) VALUES (1, 'git-local', 'repo-a', '{"aliases":["alpha","beta"]}', 0, 0)`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO collect_sources (id, type, name, config, created_at, updated_at) VALUES (2, 'git-local', 'repo-b', '{"aliases":["gamma"]}', 0, 0)`,
	); err != nil {
		t.Fatal(err)
	}

	sources, err := q.ListCollectSourcesByNameOrAlias(ctx, "%alp%")
	if err != nil {
		t.Fatalf("json_each query must be hand-written native SQL: %v", err)
	}
	if len(sources) != 1 || sources[0].Name != "repo-a" {
		t.Fatalf("sources = %+v", sources)
	}
}

func TestFindAPITokenByHash(t *testing.T) {
	ctx := context.Background()
	conn, q := openTestDB(t)

	token, err := q.FindAPITokenByHash(ctx, "missing")
	if err == nil {
		t.Fatalf("expected error, got %+v", token)
	}

	if _, err := conn.Exec(
		`INSERT INTO api_tokens (name, token_hash, prefix, created_at, expires_at) VALUES ('agent', 'abc123', 'wrp_abc1', 1000, 2000)`,
	); err != nil {
		t.Fatal(err)
	}
	token, err = q.FindAPITokenByHash(ctx, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if token.Name != "agent" || token.ExpiresAt == nil || *token.ExpiresAt != 2000 {
		t.Fatalf("token = %+v", token)
	}
}

func ptr[T any](v T) *T { return &v }
