package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"github.com/dev-zapi/weekly-reporter/internal/migrate"
)

// runDB 处理 `wr db <subcommand>`；args 是 "db" 之后的参数（即 os.Args[2:]）。
//
// 与 B0 骨架票（#97）的约定：
//   - main.go 的 dispatch 里以 `case "db": return runDB(os.Args[2:])` 的形式接入；
//   - serve 启动路径在打开数据库后调用 migrate.Verify(ctx, db)（即内嵌语料 +
//     只读账本校验），返回错误即拒启（fail closed），启动路径不执行任何迁移 SQL；
//   - 本文件只负责 migrate 子命令，`wr db new` 是切换后项，本票不实现。
//
// 退出码：0 成功；1 迁移或校验失败；2 用法错误。
func runDB(args []string) int {
	return runDBWith(args, os.Stdout, os.Stderr)
}

// runDBWith 把输出与错误流抽出来，便于单测断言 CLI 语义（no-op / fail closed）。
func runDBWith(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: wr db migrate")
		return 2
	}
	switch args[0] {
	case "migrate":
		return runDBMigrate(stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown db subcommand %q (only \"migrate\" is supported)\n", args[0])
		return 2
	}
}

func runDBMigrate(stdout, stderr io.Writer) int {
	corpus, err := migrate.DefaultCorpus()
	if err != nil {
		fmt.Fprintf(stderr, "加载迁移语料失败: %v\n", err)
		return 1
	}

	dbPath, err := databasePath()
	if err != nil {
		fmt.Fprintf(stderr, "解析数据库路径失败: %v\n", err)
		return 1
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		fmt.Fprintf(stderr, "创建数据目录失败: %v\n", err)
		return 1
	}

	// 与 better-sqlite3 默认对齐（ADR-0025）。事务锁由 Migrate 显式 BEGIN IMMEDIATE
	// 管理（research §7.3），不在 DSN 上重复配 _txlock。
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		fmt.Fprintf(stderr, "打开数据库失败: %v\n", err)
		return 1
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if err := db.Ping(); err != nil {
		fmt.Fprintf(stderr, "连接数据库失败: %v\n", err)
		return 1
	}

	applied, err := corpus.Migrate(context.Background(), db)
	if err != nil {
		if errors.Is(err, migrate.ErrLedgerMismatch) {
			fmt.Fprintf(stderr, "账本校验失败，拒绝迁移: %v\n", err)
		} else {
			fmt.Fprintf(stderr, "迁移失败: %v\n", err)
		}
		return 1
	}

	if applied == 0 {
		fmt.Fprintf(stdout, "no-op: 账本已是冻结头部 %d/%d，未写入任何行\n", corpus.Len(), corpus.Len())
	} else {
		fmt.Fprintf(stdout, "applied %d migration(s); 账本现为 %d/%d\n", applied, corpus.Len(), corpus.Len())
	}
	return 0
}

// databasePath 解析默认数据库路径，语义对齐 src/lib/paths.ts：
// $XDG_DATA_HOME（缺省 ~/.local/share）/weekly-reporter/reports.db。
//
// 注：B0 骨架票（#97）的 serve 也会读同一组 env；若集成时它提供统一的 paths
// 包，可把这里换成对它的复用，行为不变。
func databasePath() (string, error) {
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dataHome = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dataHome, "weekly-reporter", "reports.db"), nil
}
