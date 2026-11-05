---
status: accepted
---

# drizzle 迁移账本：冻结基线 + 只读启动校验 + 显式 `wr db migrate`

「沿用现有 SQLite 与 schema」的对等承诺落到迁移账本上：`__drizzle_migrations` 账本与 `drizzle/ + meta/_journal.json` 语料**永久保留为唯一迁移语料与唯一账本**。`wr serve` 对账本只读校验——已应用集合必须等于账本冻结头部（41/41），校验失败 fail closed 拒启，绝不执行迁移 SQL；校验需容忍历史怪癖（0002–0010 旧式 16 位哈希、0002 哈希对应重写前内容、三处 when 倒挂）。唯一写账本者是显式子命令 `wr db migrate`：按 journal 顺序应用 pending 条目，写入完整 sha256 与 journal when；迁移排序以 `_journal.json` 为准（文件名序不可靠，0012 已实证倒挂）。不复刻 drizzle 的 `max(created_at)` 光标语义，不把 0017–0019 的修复逻辑搬进启动路径。

新增迁移的产线：**过渡期**（双栈并存、TS schema 仍活）继续 `drizzle-kit generate` 产出 SQL；**切换后**手写 `NNNN_tag.sql`，`wr db new` 子命令自动算 tag/idx/when = `max(now, 账本 maxWhen+1)`（防 when 倒挂复发），CI corpus lint 守四条规则：基线 41 条快照不可变、新增条目 idx/when 严格递增、语句间 `--> statement-breakpoint`、SQL 内禁 `BEGIN/COMMIT/VACUUM/PRAGMA journal_mode`（不能安全放进迁移事务）。

## Considered Options

- **字节兼容复刻 drizzle applier**（Option A）：为 16 位旧哈希与光标语义付出长期维护，换来的只是「Go 也能跑迁移」而无新价值。
- **golang-migrate / goose**：各建第二账本（`schema_migrations` / `goose_db_version`），违背唯一账本与零迁移原则，且 goose 要求 SQL 注解格式。
- **长期继续 drizzle-kit generate**：为生成 SQL 永久维护一份与 sqlc 并行的 TS schema 副本，漂移负担自担。

## Consequences

- 升级部署多一步显式 `wr db migrate`；systemd unit 不自动跑迁移（启动只校验）。
- 现有部署零迁移动作：生产账本已在冻结头部。
- corpus lint 进 CI；`drizzle/` 目录在退役清单中**保留**。
- Go 连接串 pragma（foreign_keys/busy_timeout）见 ADR-0025，与账本策略正交。
