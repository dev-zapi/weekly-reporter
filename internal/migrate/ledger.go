package migrate

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrLedgerMismatch 是账本与冻结头部不一致的统一哨兵错误。
//
// serve 只需判断“有没有错”：任何 ErrLedgerMismatch（或其它错误）都必须拒启。
// 错误串里带上第几条 / tag / 期望与实际，方便单用户自托管场景直接定位。
var ErrLedgerMismatch = errors.New("drizzle migration ledger mismatch")

const ledgerTable = "__drizzle_migrations"

// legacyShortHashLastIdx 划定“旧式 16 位 hash”的容忍范围。
//
// 生产库里 idx 2..10（0002_update_templates_schema..0010_typical_sally_floyd）由
// 旧版 drizzle 写入，hash 只有 sha256 前 16 位；之后的条目一律是完整 64 位。
// 容忍范围之外仍要求完整 hash——否则校验会退化成“16 位碰撞即可通过”。
const legacyShortHashLastIdx = 10

// historicalHashes 记录“迁移文件在应用之后被重写”的历史例外。
//
// 0002 在 commit 9a7e847 被重写（去掉 IF EXISTS、加入 breakpoint），账本里留的是
// 重写前内容的 sha256 前 16 位；当前文件重算无论如何都对不上，只能靠这张表放行。
// 表里存完整旧 hash，比较时同时接受完整值与 16 位前缀。
var historicalHashes = map[string]string{
	"0002_update_templates_schema": "4835fdad94cb8dd0012774fa3f224069c37143c7dafb54f5626cd11289e8d317",
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ledgerRow 是账本里的一行；id 在 SQLite 里恒为 NULL（SERIAL 不是自增），
// 所以顺序必须靠 rowid，而不是 id。created_at 有意不读：它不是应用与否的凭据
// （历史上既写过 journal when，也写过应用时刻），见 VerifyLedger 注释。
type ledgerRow struct {
	hash string
}

// VerifyLedger 是 serve 启动路径调用的只读校验。
//
// 语义：__drizzle_migrations 的行集合必须逐行等于语料的冻结头部——行数相等，
// 且第 i 行的 hash 可被第 i 条条目接受。校验只发 SELECT，绝不执行迁移 SQL、
// 绝不建表；任何不一致返回包装 ErrLedgerMismatch 的错误，调用方必须 fail closed。
//
// 判定只看 hash、不看 created_at：created_at 历史上既写过 journal when（新条目）
// 也写过应用时刻（0001–0010 旧条目），拿它当凭据会让“改 hash”绕过校验。
// 因此 when 倒挂（本仓三处）天然不影响判定。
func (c *Corpus) VerifyLedger(ctx context.Context, db *sql.DB) error {
	rows, exists, err := readLedgerState(ctx, db)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: 账本表 %s 不存在（库未初始化，先跑 wr db migrate 或旧 Node 版）",
			ErrLedgerMismatch, ledgerTable)
	}
	if len(rows) != len(c.entries) {
		return countMismatchError(len(rows), len(c.entries))
	}
	if err := c.verifyPrefix(rows); err != nil {
		return err
	}
	return nil
}

// Verify 是 serve 启动路径的一站式入口：
//
//	err := migrate.Verify(ctx, db)   // db 为已打开的 *sql.DB（modernc "sqlite" 驱动）
//	if err != nil { /* fail closed：拒绝启动，不执行任何迁移 SQL */ }
//
// 它内部加载内嵌语料再做只读账本校验，语义与 (*Corpus).VerifyLedger 完全一致；
// 需要的注入点（自定义语料）用 Corpus.VerifyLedger。
func Verify(ctx context.Context, db *sql.DB) error {
	corpus, err := DefaultCorpus()
	if err != nil {
		return fmt.Errorf("加载迁移语料失败: %w", err)
	}
	return corpus.VerifyLedger(ctx, db)
}

// verifyPrefix 校验账本行是语料的合法前缀（供 Migrate 复用）。
func (c *Corpus) verifyPrefix(rows []ledgerRow) error {
	if len(rows) > len(c.entries) {
		return fmt.Errorf("%w: 账本有 %d 行，多于语料 %d 条（二进制比数据库旧，先升级二进制）",
			ErrLedgerMismatch, len(rows), len(c.entries))
	}
	for i, row := range rows {
		if !c.accepts(i, row.hash) {
			e := c.entries[i]
			return fmt.Errorf("%w: 第 %d 条 %s 的账本 hash %q 与语料不符（期望完整 sha256 %s%s）",
				ErrLedgerMismatch, i, e.Tag, row.hash, e.hash,
				legacyHint(i))
		}
	}
	return nil
}

// countMismatchError 把行数差异翻译成可操作的提示（research §7.2-7）。
func countMismatchError(applied, head int) error {
	switch {
	case applied < head:
		return fmt.Errorf("%w: 账本 %d/%d 条（缺尾部条目；先跑 wr db migrate，或用最后一个 Node 版完成历史修复后再迁移）",
			ErrLedgerMismatch, applied, head)
	case applied > head:
		return fmt.Errorf("%w: 账本 %d/%d 条（数据库比二进制新；升级 wr 二进制后再启动）",
			ErrLedgerMismatch, applied, head)
	default:
		return fmt.Errorf("%w: 账本 %d/%d 条", ErrLedgerMismatch, applied, head)
	}
}

func legacyHint(i int) string {
	if i > legacyShortHashLastIdx {
		return ""
	}
	return "（该条为旧式 16 位 hash 或被重写过的历史条目）"
}

// accepts 判定第 i 条账本 hash 是否可被语料接受：
//  1. 完整 sha256（新条目；包括 0001 这类 hash 对、created_at 记录应用时刻的行）；
//  2. 旧式 16 位前缀（只限 idx <= legacyShortHashLastIdx 的历史区）；
//  3. 历史例外表（0002 重写前内容，完整值或 16 位前缀）。
func (c *Corpus) accepts(i int, hash string) bool {
	e := c.entries[i]
	if hash == e.hash {
		return true
	}
	if i <= legacyShortHashLastIdx && len(hash) == 16 && hash == e.hash[:16] {
		return true
	}
	if legacy, ok := historicalHashes[e.Tag]; ok {
		if hash == legacy || (len(hash) == 16 && strings.HasPrefix(legacy, hash)) {
			return true
		}
	}
	return false
}

// querier 是 *sql.DB / *sql.Conn / *sql.Tx 的公共查询面：
// 迁移事务内复核账本要用同一个连接，所以这里不写死 *sql.DB。
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// readLedgerState 以 rowid 顺序读取账本，并报告账本表是否存在。
// 表不存在不是错误（空库可以从零应用），是否接受由调用方决定。
func readLedgerState(ctx context.Context, q querier) (rows []ledgerRow, exists bool, err error) {
	var found int
	if err := q.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, ledgerTable,
	).Scan(&found); err != nil {
		return nil, false, fmt.Errorf("%w: 检查账本表: %v", ErrLedgerMismatch, err)
	}
	if found == 0 {
		return nil, false, nil
	}

	rs, err := q.QueryContext(ctx, `SELECT hash FROM `+ledgerTable+` ORDER BY rowid`)
	if err != nil {
		return nil, true, fmt.Errorf("%w: 读取账本: %v", ErrLedgerMismatch, err)
	}
	defer rs.Close()

	for rs.Next() {
		var row ledgerRow
		if err := rs.Scan(&row.hash); err != nil {
			return nil, true, fmt.Errorf("%w: 解析账本行: %v", ErrLedgerMismatch, err)
		}
		rows = append(rows, row)
	}
	if err := rs.Err(); err != nil {
		return nil, true, fmt.Errorf("%w: 遍历账本: %v", ErrLedgerMismatch, err)
	}
	return rows, true, nil
}
