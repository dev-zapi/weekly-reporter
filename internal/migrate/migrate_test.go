package migrate_test

// 本文件是票 #98 的迁移器单测：先写红、再实现到绿。
// 覆盖票内「测试随票走」列出的六项：旧式 16 位哈希容错、0002 内容差异容错、
// when 倒挂容错、冻结库 no-op、缺尾部条目按 journal 序补齐、账本不一致 fail closed。
//
// 测试用 fstest.MapFS 造合成语料（真实语料只在 TestEmbeddedCorpusFrozenHead /
// TestVerifyLedgerAcceptsProductionQuirks 里出现），这样每个容错分支都能精确断言。

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	_ "modernc.org/sqlite"

	"github.com/dev-zapi/weekly-reporter/internal/migrate"
)

// ---------------------------------------------------------------- helpers

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// newDB 在 t.TempDir 里开一个真实 SQLite 文件库（modernc 驱动），
// 不用 :memory:，因为要验证“冻结库 no-op 不动一行”这类落盘语义。
func newDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "reports.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Ping(); err != nil {
		t.Fatalf("ping sqlite: %v", err)
	}
	return db
}

// createLedger 建与 drizzle 完全一致的账本表（id 不会自增，实际全是 NULL）。
func createLedger(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
		id SERIAL PRIMARY KEY,
		hash text NOT NULL,
		created_at numeric
	)`); err != nil {
		t.Fatalf("create ledger: %v", err)
	}
}

func insertLedger(t *testing.T, db *sql.DB, hash string, createdAt int64) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`, hash, createdAt,
	); err != nil {
		t.Fatalf("insert ledger: %v", err)
	}
}

func ledgerRows(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT hash || '|' || created_at FROM __drizzle_migrations ORDER BY rowid`)
	if err != nil {
		t.Fatalf("query ledger: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan ledger: %v", err)
		}
		out = append(out, s)
	}
	return out
}

// testCorpus 造一份合成语料：entries 给出 idx/tag/when，sqls 给出每个 tag 的文件内容。
func testCorpus(t *testing.T, whens []int64, tags []string, sqls map[string]string) *migrate.Corpus {
	t.Helper()
	if len(whens) != len(tags) {
		t.Fatalf("testCorpus: whens/tags 长度不一致")
	}
	type journalEntry struct {
		IDX         int    `json:"idx"`
		Version     string `json:"version"`
		When        int64  `json:"when"`
		Tag         string `json:"tag"`
		Breakpoints bool   `json:"breakpoints"`
	}
	type journal struct {
		Version string         `json:"version"`
		Dialect string         `json:"dialect"`
		Entries []journalEntry `json:"entries"`
	}
	j := journal{Version: "7", Dialect: "sqlite"}
	for i, tag := range tags {
		body, ok := sqls[tag]
		if !ok {
			t.Fatalf("testCorpus: 缺少 %s 的 SQL", tag)
		}
		j.Entries = append(j.Entries, journalEntry{
			IDX: i, Version: "6", When: whens[i], Tag: tag, Breakpoints: true,
		})
		_ = body
	}
	raw, err := json.Marshal(j)
	if err != nil {
		t.Fatalf("marshal journal: %v", err)
	}
	fsys := fstest.MapFS{
		"drizzle/meta/_journal.json": &fstest.MapFile{Data: raw},
	}
	for tag, body := range sqls {
		fsys["drizzle/"+tag+".sql"] = &fstest.MapFile{Data: []byte(body)}
	}
	corpus, err := migrate.LoadCorpus(fsys)
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	return corpus
}

// ---------------------------------------------------------------- T1

// 旧式 16 位哈希：0002–0010 当年由老版本 drizzle 写入 sha256 前 16 位。
func TestVerifyLedgerToleratesLegacyShortHash(t *testing.T) {
	corpus := testCorpus(t,
		[]int64{100, 200, 300},
		[]string{"0000_init", "0005_legacy", "0020_tail"},
		map[string]string{
			"0000_init":   "CREATE TABLE a (id integer);",
			"0005_legacy": "CREATE TABLE b (id integer);",
			"0020_tail":   "CREATE TABLE c (id integer);",
		})
	db := newDB(t)
	createLedger(t, db)
	files := map[string]string{
		"0000_init":   "CREATE TABLE a (id integer);",
		"0005_legacy": "CREATE TABLE b (id integer);",
		"0020_tail":   "CREATE TABLE c (id integer);",
	}
	// 第 2 行用旧式 16 位 hash，created_at 是“应用时刻”而非 journal when，
	// 校验必须只看 hash 前缀、不看 created_at。
	insertLedger(t, db, sha256Hex([]byte(files["0000_init"])), 999)
	insertLedger(t, db, sha256Hex([]byte(files["0005_legacy"]))[:16], 1001)
	insertLedger(t, db, sha256Hex([]byte(files["0020_tail"])), 300)

	if err := corpus.VerifyLedger(context.Background(), db); err != nil {
		t.Fatalf("旧式 16 位哈希应被容忍，却失败: %v", err)
	}
}

// ---------------------------------------------------------------- T2

// 0002 的 hash 对应 9a7e847 重写前的文件内容，当前文件重算永远对不上，
// 只能靠固定的历史例外表放行；同 tag 的其它 hash 仍须 fail closed。
func TestVerifyLedgerToleratesRewrittenMigration0002(t *testing.T) {
	const tag = "0002_update_templates_schema"
	const rewritten = "ALTER TABLE templates ADD COLUMN description text;"
	corpus := testCorpus(t,
		[]int64{100, 200, 300},
		[]string{"0000_init", tag, "0020_tail"},
		map[string]string{
			"0000_init": "CREATE TABLE templates (id integer);",
			tag:         rewritten,
			"0020_tail": "CREATE TABLE c (id integer);",
		})

	t.Run("历史例外 hash 放行", func(t *testing.T) {
		db := newDB(t)
		createLedger(t, db)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE templates (id integer);")), 100)
		insertLedger(t, db, "4835fdad94cb8dd0", 1001)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE c (id integer);")), 300)
		if err := corpus.VerifyLedger(context.Background(), db); err != nil {
			t.Fatalf("0002 历史例外应放行，却失败: %v", err)
		}
	})

	t.Run("同 tag 的其它 hash 不放行", func(t *testing.T) {
		db := newDB(t)
		createLedger(t, db)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE templates (id integer);")), 100)
		insertLedger(t, db, "deadbeefdeadbeef", 1001)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE c (id integer);")), 300)
		err := corpus.VerifyLedger(context.Background(), db)
		if err == nil {
			t.Fatalf("0002 的伪造 hash 应 fail closed")
		}
		if !errors.Is(err, migrate.ErrLedgerMismatch) {
			t.Fatalf("错误应可判定为账本不一致，实际: %v", err)
		}
	})
}

// ---------------------------------------------------------------- T3

// when 倒挂：journal 的 when 不单调（本仓 0002/0003、0017/0018、0028/0029 三处），
// 校验不得要求 created_at 单调，也不得把 when 当排序键。
func TestVerifyLedgerToleratesInvertedWhen(t *testing.T) {
	corpus := testCorpus(t,
		[]int64{300, 100, 200},
		[]string{"0001_a", "0002_b", "0003_c"},
		map[string]string{
			"0001_a": "CREATE TABLE a (id integer);",
			"0002_b": "CREATE TABLE b (id integer);",
			"0003_c": "CREATE TABLE c (id integer);",
		})
	db := newDB(t)
	createLedger(t, db)
	// created_at 忠实记账 journal when（含倒挂）；也有旧库按应用时刻记的偏差值。
	insertLedger(t, db, sha256Hex([]byte("CREATE TABLE a (id integer);")), 300)
	insertLedger(t, db, sha256Hex([]byte("CREATE TABLE b (id integer);")), 100)
	insertLedger(t, db, sha256Hex([]byte("CREATE TABLE c (id integer);")), 200)

	if err := corpus.VerifyLedger(context.Background(), db); err != nil {
		t.Fatalf("when 倒挂不应影响判定，却失败: %v", err)
	}
}

// ---------------------------------------------------------------- T4

// 冻结库 no-op：账本已是头部时 migrate 一行都不写。
func TestMigrateNoOpOnFrozenLedger(t *testing.T) {
	const sqlForA = "CREATE TABLE a (id integer);"
	const sqlForB = "CREATE TABLE b (id integer);"
	corpus := testCorpus(t,
		[]int64{100, 200},
		[]string{"0000_a", "0001_b"},
		map[string]string{"0000_a": sqlForA, "0001_b": sqlForB})
	db := newDB(t)
	createLedger(t, db)
	insertLedger(t, db, sha256Hex([]byte(sqlForA)), 100)
	insertLedger(t, db, sha256Hex([]byte(sqlForB)), 200)
	before := ledgerRows(t, db)

	applied, err := corpus.Migrate(context.Background(), db)
	if err != nil {
		t.Fatalf("冻结库 migrate 应成功: %v", err)
	}
	if applied != 0 {
		t.Fatalf("冻结库应 no-op，实际应用 %d 条", applied)
	}
	if after := ledgerRows(t, db); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("冻结库账本被改动:\nbefore=%v\nafter=%v", before, after)
	}
}

// ---------------------------------------------------------------- T5

// 缺尾部条目：按 journal 数组顺序补齐（文件名序与 when 都不是排序键），
// 新行写完整 sha256 与 journal when。
func TestMigrateAppliesMissingTailInJournalOrder(t *testing.T) {
	// 故意让文件名序与 journal 序相反、when 倒挂：
	// journal 序 = [init, 0012_beta(when=100), 0012_alpha(when=50)]
	// 文件名序会给 alpha 先、when 序也会给 alpha 先——两者都错。
	const (
		initSQL  = "CREATE TABLE log (name text);"
		betaSQL  = "INSERT INTO log (name) VALUES ('beta');"
		alphaSQL = "INSERT INTO log (name) VALUES ('alpha');"
	)
	corpus := testCorpus(t,
		[]int64{10, 100, 50},
		[]string{"0000_init", "0012_beta", "0012_alpha"},
		map[string]string{
			"0000_init":  initSQL,
			"0012_beta":  betaSQL,
			"0012_alpha": alphaSQL,
		})
	db := newDB(t)
	createLedger(t, db)
	insertLedger(t, db, sha256Hex([]byte(initSQL)), 10)
	if _, err := db.Exec(initSQL); err != nil { // 模拟已应用到 init 的库
		t.Fatalf("exec init: %v", err)
	}

	applied, err := corpus.Migrate(context.Background(), db)
	if err != nil {
		t.Fatalf("补齐尾部应成功: %v", err)
	}
	if applied != 2 {
		t.Fatalf("应补齐 2 条，实际 %d", applied)
	}
	if err := corpus.VerifyLedger(context.Background(), db); err != nil {
		t.Fatalf("补齐后账本应通过校验: %v", err)
	}

	rows, err := db.Query(`SELECT name FROM log ORDER BY rowid`)
	if err != nil {
		t.Fatalf("query log: %v", err)
	}
	defer rows.Close()
	var order []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan log: %v", err)
		}
		order = append(order, name)
	}
	if got := strings.Join(order, ","); got != "beta,alpha" {
		t.Fatalf("应用顺序必须按 journal 序（beta,alpha），实际 %q", got)
	}

	ledger := ledgerRows(t, db)
	if len(ledger) != 3 {
		t.Fatalf("补齐后账本应有 3 行，实际 %d", len(ledger))
	}
	// 新行必须写完整 sha256 与 journal when。
	if want := fmt.Sprintf("%s|100", sha256Hex([]byte(betaSQL))); ledger[1] != want {
		t.Fatalf("第 2 行应为 %s，实际 %s", want, ledger[1])
	}
	if want := fmt.Sprintf("%s|50", sha256Hex([]byte(alphaSQL))); ledger[2] != want {
		t.Fatalf("第 3 行应为 %s，实际 %s", want, ledger[2])
	}
}

// ---------------------------------------------------------------- T6

// 账本不一致一律 fail closed：改 hash、删行、多行、缺表、以及 migrate 前置校验。
func TestVerifyLedgerFailsClosed(t *testing.T) {
	corpus := testCorpus(t,
		[]int64{100, 200, 300},
		[]string{"0000_a", "0011_b", "0020_c"},
		map[string]string{
			"0000_a": "CREATE TABLE a (id integer);",
			"0011_b": "CREATE TABLE b (id integer);",
			"0020_c": "CREATE TABLE c (id integer);",
		})
	seed := func(t *testing.T) *sql.DB {
		db := newDB(t)
		createLedger(t, db)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE a (id integer);")), 100)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE b (id integer);")), 200)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE c (id integer);")), 300)
		return db
	}

	t.Run("改 hash", func(t *testing.T) {
		db := seed(t)
		if _, err := db.Exec(`UPDATE __drizzle_migrations SET hash = 'tampered' WHERE rowid = 2`); err != nil {
			t.Fatalf("tamper: %v", err)
		}
		err := corpus.VerifyLedger(context.Background(), db)
		if !errors.Is(err, migrate.ErrLedgerMismatch) {
			t.Fatalf("篡改 hash 应 fail closed，实际: %v", err)
		}
	})

	t.Run("删行", func(t *testing.T) {
		db := seed(t)
		if _, err := db.Exec(`DELETE FROM __drizzle_migrations WHERE rowid = 3`); err != nil {
			t.Fatalf("delete: %v", err)
		}
		err := corpus.VerifyLedger(context.Background(), db)
		if !errors.Is(err, migrate.ErrLedgerMismatch) {
			t.Fatalf("缺条目应 fail closed，实际: %v", err)
		}
	})

	t.Run("多行", func(t *testing.T) {
		db := seed(t)
		insertLedger(t, db, sha256Hex([]byte("CREATE TABLE d (id integer);")), 400)
		err := corpus.VerifyLedger(context.Background(), db)
		if !errors.Is(err, migrate.ErrLedgerMismatch) {
			t.Fatalf("多余条目应 fail closed，实际: %v", err)
		}
	})

	t.Run("缺账本表", func(t *testing.T) {
		db := newDB(t)
		err := corpus.VerifyLedger(context.Background(), db)
		if !errors.Is(err, migrate.ErrLedgerMismatch) {
			t.Fatalf("缺账本表应 fail closed，实际: %v", err)
		}
	})

	t.Run("migrate 前置校验失败不写入", func(t *testing.T) {
		db := seed(t)
		if _, err := db.Exec(`UPDATE __drizzle_migrations SET hash = 'tampered' WHERE rowid = 1`); err != nil {
			t.Fatalf("tamper: %v", err)
		}
		before := ledgerRows(t, db)
		if _, err := corpus.Migrate(context.Background(), db); !errors.Is(err, migrate.ErrLedgerMismatch) {
			t.Fatalf("migrate 遇错账本应 fail closed 且不写入，实际: %v", err)
		}
		if after := ledgerRows(t, db); strings.Join(after, ",") != strings.Join(before, ",") {
			t.Fatalf("fail closed 时账本不应被改动")
		}
	})
}

// ---------------------------------------------------------------- corpus

// 真实语料必须冻结在 41 条，结构自洽（dialect/idx/tag/文件齐全）。
func TestEmbeddedCorpusFrozenHead(t *testing.T) {
	corpus, err := migrate.DefaultCorpus()
	if err != nil {
		t.Fatalf("DefaultCorpus: %v", err)
	}
	if n := corpus.Len(); n != 41 {
		t.Fatalf("冻结头部应为 41 条，实际 %d", n)
	}
	if corpus.Dialect() != "sqlite" {
		t.Fatalf("dialect 应为 sqlite，实际 %q", corpus.Dialect())
	}
}

// 用真实语料复刻生产账本的历史怪癖（16 位 hash、0002 重写前内容、应用时刻
// created_at、when 倒挂），校验必须通过——这就是 serve 启动时面对的真实形状。
func TestVerifyLedgerAcceptsProductionQuirks(t *testing.T) {
	const legacy0002 = "4835fdad94cb8dd0"
	corpus, err := migrate.DefaultCorpus()
	if err != nil {
		t.Fatalf("DefaultCorpus: %v", err)
	}
	db := newDB(t)
	createLedger(t, db)

	entries := corpus.Entries()
	for i, e := range entries {
		hash := sha256Hex(e.SQL)
		switch {
		case i == 2:
			hash = legacy0002
		case i >= 2 && i <= 10:
			hash = hash[:16]
		}
		// 0001–0010 的 created_at 是应用时刻；这里统一用一个与 when 不同的值，
		// 证明校验不拿 created_at 当凭据。
		createdAt := e.When
		if i >= 1 && i <= 10 {
			createdAt = 1783327500000
		}
		insertLedger(t, db, hash, createdAt)
	}
	if err := corpus.VerifyLedger(context.Background(), db); err != nil {
		t.Fatalf("生产形状的账本应通过校验: %v", err)
	}
}
