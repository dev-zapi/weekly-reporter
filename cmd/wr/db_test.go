package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/dev-zapi/weekly-reporter/internal/migrate"
)

// seedFrozenDB 在临时 XDG_DATA_HOME 下造一个“已冻结到头部”的库：
// 账本 41 行齐全，业务表不建——db migrate 的判定只看账本前缀，不看业务 schema。
func seedFrozenDB(t *testing.T) (dataHome, dbPath string) {
	t.Helper()
	corpus, err := migrate.DefaultCorpus()
	if err != nil {
		t.Fatalf("DefaultCorpus: %v", err)
	}
	dataHome = t.TempDir()
	dir := filepath.Join(dataHome, "weekly-reporter")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath = filepath.Join(dir, "reports.db")
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE __drizzle_migrations (
		id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`); err != nil {
		t.Fatalf("create ledger: %v", err)
	}
	for _, e := range corpus.Entries() {
		sum := sha256.Sum256(e.SQL)
		if _, err := db.Exec(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
			hex.EncodeToString(sum[:]), e.When); err != nil {
			t.Fatalf("insert ledger: %v", err)
		}
	}
	return dataHome, dbPath
}

func ledgerCount(t *testing.T, dbPath string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		t.Fatalf("open ro: %v", err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM __drizzle_migrations`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestRunDBMigrateNoOpOnFrozenDatabase(t *testing.T) {
	dataHome, dbPath := seedFrozenDB(t)
	t.Setenv("XDG_DATA_HOME", dataHome)

	var stdout, stderr bytes.Buffer
	if code := runDBWith([]string{"migrate"}, &stdout, &stderr); code != 0 {
		t.Fatalf("冻结库应 no-op 退出 0，实际 %d，stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "no-op") {
		t.Fatalf("no-op 应明说未写入任何行，实际 stdout=%q", stdout.String())
	}
	if n := ledgerCount(t, dbPath); n != 41 {
		t.Fatalf("冻结库账本行数应保持 41，实际 %d", n)
	}
}

func TestRunDBMigrateFailsClosedOnTamperedLedger(t *testing.T) {
	dataHome, dbPath := seedFrozenDB(t)
	t.Setenv("XDG_DATA_HOME", dataHome)

	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`UPDATE __drizzle_migrations SET hash = 'tampered' WHERE rowid = 7`); err != nil {
		t.Fatalf("tamper: %v", err)
	}
	_ = db.Close()

	var stdout, stderr bytes.Buffer
	if code := runDBWith([]string{"migrate"}, &stdout, &stderr); code != 1 {
		t.Fatalf("账本被篡改应退出 1，实际 %d", code)
	}
	if !strings.Contains(stderr.String(), "账本校验失败") {
		t.Fatalf("应输出账本校验失败，实际 stderr=%q", stderr.String())
	}
	if n := ledgerCount(t, dbPath); n != 41 {
		t.Fatalf("fail closed 时账本不应被改动，实际 %d 行", n)
	}
}

func TestRunDBRejectsUnknownSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runDBWith([]string{"new"}, &stdout, &stderr); code != 2 {
		t.Fatalf("未实现的子命令应退出 2，实际 %d", code)
	}
	if code := runDBWith(nil, &stdout, &stderr); code != 2 {
		t.Fatalf("缺子命令应退出 2，实际 %d", code)
	}
}
