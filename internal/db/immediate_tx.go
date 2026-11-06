package db

import (
	"context"
	"database/sql"
)

// InImmediateTx 与 InTx 同形，但用 `BEGIN IMMEDIATE` 开启事务。
//
// 为什么要单独一条路径（ADR-0027 / ticket #110）：生成消息 part 的序列号是
// `max(sequence)+1` 再插入。Next 运行时与 Go 服务共用同一个 SQLite 文件，
// 默认的 deferred 事务会先拿读锁、到插入时才升级写锁，两个写者可能读到同一个
// max 后一个失败（SQLITE_BUSY）或需要重试。BEGIN IMMEDIATE 在事务开始就取写锁，
// 把「读 max + 插入」变成一个跨进程的临界区（busy_timeout=5000 负责等待）。
//
// 底层不是 *sql.DB 时（调用方已经在事务里）退化为 InTx：与 drizzle 的内层
// transaction 不再另开事务的行为一致。
func (q *Queries) InImmediateTx(ctx context.Context, fn func(*Queries) error) error {
	pool, ok := q.db.(*sql.DB)
	if !ok {
		return q.InTx(ctx, fn)
	}

	conn, err := pool.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			// 回滚不跟随已取消的 ctx：客户端断连时收尾事务必须能清掉。
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		}
	}()

	if err := fn(New(conn)); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	committed = true
	return nil
}
