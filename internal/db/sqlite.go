package db

import (
	"database/sql"

	// modernc 驱动注册名为 "sqlite"；纯 Go 实现，CGO_ENABLED=0 也能构建。
	_ "modernc.org/sqlite"
)

// DSN 拼出 modernc 的连接串。两个 pragma 对齐 better-sqlite3 的默认行为
// （ADR-0025）：外键开启、写冲突最多等 5s 而不是立刻报 SQLITE_BUSY。
func DSN(path string) string {
	return "file:" + path + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
}

// Open 打开 SQLite 连接池。注意 sql.Open 是惰性的：真正建库发生在第一次连接时。
func Open(path string) (*sql.DB, error) {
	return sql.Open("sqlite", DSN(path))
}
