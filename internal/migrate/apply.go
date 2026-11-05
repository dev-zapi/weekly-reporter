package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// statementBreakpoint 是 drizzle 的语句分隔符字面量；只按字面量切分，不做
// 换行归一化（与 drizzle 的 readMigrationFiles 行为一致）。
const statementBreakpoint = "--> statement-breakpoint"

// ledgerDDL 与 drizzle 建表完全一致：SQLite 里 SERIAL 不是自增别名，id 恒为
// NULL，因此插入只写 (hash, created_at)，排序只认 rowid。
const ledgerDDL = `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
	id SERIAL PRIMARY KEY,
	hash text NOT NULL,
	created_at numeric
)`

// Migrate 是 `wr db migrate` 的实现，也是唯一写账本者（ADR-0026）。
//
// 语义：
//  1. 先做与 serve 相同的账本前缀校验；不是合法前缀就 fail closed、不写任何东西；
//  2. pending = journal.entries[已应用行数:]，按 journal 数组顺序应用（文件名序
//     与 when 序都靠不住：0012 文件名倒挂、0017/0018 等 when 倒挂）；
//  3. 每条 pending 在一个事务内逐语句执行，随后写一行 (完整 sha256, journal when)；
//     任一步失败整体回滚，库回到迁移前状态；
//  4. 已冻结库（账本已在头部）直接返回 0，一行都不写。
//
// 这里不复刻 drizzle 的 max(created_at) 光标（“是否已应用”只由前缀决定，不看 hash
// 也不看 when），也不搬 0017–0019 的漂移修复逻辑——那些只服务于旧备份的抢救路径。
// 新增条目 when 必须递增的守卫属于 ADR-0026 的 CI corpus lint（切换后项），不在本命令里。
func (c *Corpus) Migrate(ctx context.Context, db *sql.DB) (int, error) {
	rows, exists, err := readLedgerState(ctx, db)
	if err != nil {
		return 0, err
	}
	if err := c.verifyPrefix(rows); err != nil {
		return 0, err
	}

	pendingFrom := len(rows)
	if pendingFrom == len(c.entries) {
		return 0, nil // 冻结库 no-op：不开事务、不建表、不动一行
	}

	conn, err := db.Conn(ctx)
	if err != nil {
		return 0, fmt.Errorf("获取数据库连接: %w", err)
	}
	defer conn.Close()

	// BEGIN IMMEDIATE：先拿写锁，避免“先读后写”在并发下的升级死锁（research §7.3）。
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return 0, fmt.Errorf("开启迁移事务: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			// 即便外部 ctx 已取消也要尝试回滚，否则写锁会跟着连接拖到关闭。
			if _, rbErr := conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK"); rbErr != nil {
				_ = rbErr // 回滚失败只能放弃；错误路径已经在返回错误
			}
		}
	}()

	if !exists {
		if _, err := conn.ExecContext(ctx, ledgerDDL); err != nil {
			return 0, fmt.Errorf("创建账本表: %w", err)
		}
	}
	// 事务内复核，避免校验与应用之间被别的进程写入。
	rows, _, err = readLedgerState(ctx, conn)
	if err != nil {
		return 0, err
	}
	if err := c.verifyPrefix(rows); err != nil {
		return 0, err
	}
	pendingFrom = len(rows)

	applied := 0
	for i := pendingFrom; i < len(c.entries); i++ {
		e := c.entries[i]
		for _, stmt := range splitStatements(e.SQL) {
			if _, err := conn.ExecContext(ctx, stmt); err != nil {
				return 0, fmt.Errorf("应用迁移 %s 失败: %w", e.Tag, err)
			}
		}
		if _, err := conn.ExecContext(ctx,
			`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`, e.hash, e.When,
		); err != nil {
			return 0, fmt.Errorf("记账迁移 %s 失败: %w", e.Tag, err)
		}
		applied++
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return 0, fmt.Errorf("提交迁移事务: %w", err)
	}
	committed = true
	return applied, nil
}

// splitStatements 按 drizzle 的字面量分隔符切分语句。
// 空白片段跳过：SQLite 对空语句本就是 no-op，跳过只为避免驱动层报错噪音。
func splitStatements(sqlText []byte) []string {
	parts := strings.Split(string(sqlText), statementBreakpoint)
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}
