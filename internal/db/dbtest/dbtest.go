// Package dbtest 提供一批用完即弃的 SQLite 库，已套用生产 schema，给需要真实
// SQL（而不是 mock）的测试用。
//
// schema 取 internal/db/schema.sql——drizzle 语料的只读合并视图（ADR-0025），
// 因此测试库与线上库结构完全一致。这里刻意用临时文件而不是 :memory:：
// DSN 上的 pragma（foreign_keys、busy_timeout）只在真实连接上生效。
package dbtest

import (
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// New 返回一个建在 t.TempDir() 里、已套用 schema.sql 的库，测试结束时关闭。
func New(t *testing.T) *sql.DB {
	t.Helper()

	conn, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	applySchema(t, conn)
	return conn
}

// applySchema 逐条重放合并后的 schema。按 ";" 切分与 internal/db 现有测试一致：
// schema.sql 是脚本生成的 DDL，字面量里不含分号。
func applySchema(t *testing.T, conn *sql.DB) {
	t.Helper()

	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("locate test helper")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "schema.sql"))
	if err != nil {
		t.Fatalf("read schema.sql: %v", err)
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
}
