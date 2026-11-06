package db

import (
	"context"
	"database/sql"
)

// txBeginner 是连接池才有的能力；*sql.Tx 不满足它（避免把嵌套事务误当真事务）。
type txBeginner interface {
	BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error)
}

// InTx 在一个事务里执行 fn，fn 拿到的 *Queries 绑定在该事务上。
//
// 为什么放在 db 包：sqlc 生成的 Queries 只暴露 DBTX，而域路由的 Deps 只带
// *db.Queries（B1 形状）。B2 的写路径要复刻 route.ts 的 `db.transaction`
// （标签双存储、引用表、删除级联都要求多语句原子提交），所以在这里把
// 「底层是连接池就开事务」的能力补上，而不是去改 router.Options。
//
// 底层不是连接池时（例如已经在事务里）退化为直接执行：与 drizzle 的内层
// transaction 不再另开事务的行为一致。
func (q *Queries) InTx(ctx context.Context, fn func(*Queries) error) error {
	beginner, ok := q.db.(txBeginner)
	if !ok {
		return fn(q)
	}

	tx, err := beginner.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(q.WithTx(tx)); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		return err
	}
	return nil
}
