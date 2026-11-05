// Package migrate 承载冻结迁移账本（__drizzle_migrations）的只读校验与显式迁移应用。
//
// 分工（ADR-0026）：
//   - serve 启动路径只调用 VerifyLedger：已应用集合必须等于语料头部，任何不一致
//     fail closed，绝不执行迁移 SQL；
//   - 唯一写账本者是 `wr db migrate`（cmd/wr/db.go），它按 _journal.json 的数组
//     顺序应用 pending 条目，写入完整 sha256 与 journal when。
//
// 语料（drizzle/ + meta/_journal.json）保持原位、原格式：它同时是 drizzle-kit
// 与过渡期 Node 版的输入。内嵌声明在仓根（go:embed 不能跨包目录），本包只解析。
package migrate

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"strings"

	assets "github.com/dev-zapi/weekly-reporter"
)

const (
	// journalPath 与 sqlDir 与 drizzle-kit 的 out 目录结构一致，不可改。
	journalPath = "drizzle/meta/_journal.json"
	sqlDir      = "drizzle"
)

// journal 是 drizzle 生成器写出的 journal 文件（v7 格式）。
type journal struct {
	Version string         `json:"version"`
	Dialect string         `json:"dialect"`
	Entries []journalEntry `json:"entries"`
}

type journalEntry struct {
	IDX  int    `json:"idx"`
	When int64  `json:"when"`
	Tag  string `json:"tag"`
}

// Entry 是校验与应用的最小单元：journal 顺序即数组顺序（不是文件名序，也不是
// when 序——0012 与 0017/0018 已经实证两者都会倒挂）。
type Entry struct {
	IDX  int
	Tag  string
	When int64
	// SQL 是迁移文件的原始字节，hash 必须由它重算（不做换行归一化）。
	SQL  []byte
	hash string
}

// Hash 返回该条目的完整 sha256 hex（小写 64 位）。
func (e Entry) Hash() string { return e.hash }

// Corpus 是已加载并自校验过的迁移语料。
type Corpus struct {
	dialect string
	entries []Entry
}

// LoadCorpus 从任意文件系统加载语料；fsys 的根必须对齐仓库根
// （即路径 drizzle/meta/_journal.json 可读）。
//
// 这里做的是“构建/语料问题”的校验（dialect、idx 连续、tag 唯一、文件齐全），
// 与账本校验分开：语料坏了说明二进制不对，账本坏了说明库不对。
func LoadCorpus(fsys fs.FS) (*Corpus, error) {
	raw, err := fs.ReadFile(fsys, journalPath)
	if err != nil {
		return nil, fmt.Errorf("读取 %s: %w", journalPath, err)
	}
	var j journal
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", journalPath, err)
	}
	if j.Dialect != "sqlite" {
		return nil, fmt.Errorf("journal dialect 应为 sqlite，实际 %q", j.Dialect)
	}
	if len(j.Entries) == 0 {
		return nil, fmt.Errorf("journal 没有任何条目")
	}

	entries := make([]Entry, 0, len(j.Entries))
	tags := make(map[string]struct{}, len(j.Entries))
	for i, je := range j.Entries {
		if je.IDX != i {
			return nil, fmt.Errorf("journal 条目 idx 不连续：第 %d 个的 idx=%d，期望 %d", i, je.IDX, i)
		}
		if strings.TrimSpace(je.Tag) == "" {
			return nil, fmt.Errorf("journal 第 %d 条 tag 为空", i)
		}
		if _, dup := tags[je.Tag]; dup {
			return nil, fmt.Errorf("journal tag 重复：%s", je.Tag)
		}
		tags[je.Tag] = struct{}{}

		body, err := fs.ReadFile(fsys, path.Join(sqlDir, je.Tag+".sql"))
		if err != nil {
			return nil, fmt.Errorf("读取迁移文件 %s.sql: %w", je.Tag, err)
		}
		entries = append(entries, Entry{
			IDX:  je.IDX,
			Tag:  je.Tag,
			When: je.When,
			SQL:  body,
			hash: sha256Hex(body),
		})
	}

	return &Corpus{dialect: j.Dialect, entries: entries}, nil
}

// DefaultCorpus 加载内嵌语料（serve 与 wr db migrate 都走这里）。
func DefaultCorpus() (*Corpus, error) {
	return LoadCorpus(assets.Migrations)
}

// Len 返回冻结头部条目数（当前生产库为 41）。
func (c *Corpus) Len() int { return len(c.entries) }

// Dialect 返回 journal 方言。
func (c *Corpus) Dialect() string { return c.dialect }

// Entries 返回语料条目的副本，调用方可安全持有。
func (c *Corpus) Entries() []Entry {
	out := make([]Entry, len(c.entries))
	copy(out, c.entries)
	return out
}
