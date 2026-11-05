// Package dbtest opens throwaway SQLite databases with the production schema
// applied, for tests that need real SQL instead of a mock.
//
// The schema is internal/db/schema.sql — the read-only merged view of the
// drizzle corpus (ADR-0025), so a test database is structurally identical to a
// deployed one. A temp *file* is used rather than :memory: on purpose: the DSN
// pragmas (foreign_keys, busy_timeout) only exist on a real connection.
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

// New returns a database in t.TempDir() with schema.sql applied and closed on
// cleanup.
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

// applySchema replays the consolidated schema one statement at a time. Splitting
// on ";" matches the existing internal/db tests: schema.sql is generated DDL with
// no semicolons inside literals.
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
