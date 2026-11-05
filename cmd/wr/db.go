package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/migrate"
)

// runDB 处理 `wr db <subcommand>`；args 是 "db" 之后的参数（即 os.Args[2:]）。
//
// 与 B0 骨架票（#97）的约定：
//   - main.go 的 dispatch 里以 `case "db": os.Exit(runDB(os.Args[2:]))` 的形式接入
//     （runDB 返回退出码，main 需要原样传递）；
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

	// 连接参数（foreign_keys / busy_timeout）由 internal/db.Open 统一提供，与 serve
	// 共用同一条 DSN（ADR-0025）。事务锁由 Migrate 显式 BEGIN IMMEDIATE 管理
	// （research §7.3），不在 DSN 上重复配 _txlock。
	conn, err := db.Open(dbPath)
	if err != nil {
		fmt.Fprintf(stderr, "打开数据库失败: %v\n", err)
		return 1
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)

	if err := conn.Ping(); err != nil {
		fmt.Fprintf(stderr, "连接数据库失败: %v\n", err)
		return 1
	}

	applied, err := corpus.Migrate(context.Background(), conn)
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
