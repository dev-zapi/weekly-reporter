# 迁移蓝图：Next.js 单体 → Go 单二进制 + React/Vite SPA

> Wayfinder 地图 [wayfinder 地图：重写为 Go + 静态 SPA（迁移蓝图）](https://github.com/dev-zapi/weekly-reporter/issues/88) 的终点产物。
> 决策依据见 [ADR 索引](#3-adr-索引)；证据分支：`research/drizzle-journal-compat`、`research/go-ai-engine-port`、`research/go-datastack-workflow`、`prototype/vite-spa-shell`、`prototype/go-gen-engine`。

## 1. 目的与范围

把 weekly-reporter 从 Next.js 单体迁移为 **Go 单二进制**（chi + modernc.org/sqlite + sqlc + go:embed）+ **React/Vite SPA**（React Router v7 库模式），动机 = 单二进制部署 + 内存不劣于 Next 版（基线 6.1–6.2G，量化验收）。**严格行为对等**：HTTP API 契约、NDJSON 事件契约、e2e 行为、skills 全部冻结；沿用现有 SQLite 与 schema（零数据迁移）。本文是纯规划产物：施工走正常 feature 迭代，本文只定顺序、验收与切换。

**不在范围**：产品功能变更、API 契约重设计、schema 重设计、多用户/协作、性能调优专项（详见地图 Out of scope）。

## 2. 不变量（对等冻结清单）

迁移期间以下全部**不得改变**，验收以它们为准：

1. **57 条 API 路由契约**——路径、方法、请求/响应形状（含 `{error, code}` 错误形状）、状态码。逐条清单见 §5 各批次。
2. **NDJSON 生成引擎 10 种线事件**与语义（stopWhen OR + 工具执行后评估、500ms 节流落库、停止/断连/失败三路径收尾）——ADR-0027。
3. **e2e 行为**——现有 spec 零改动；「全量 e2e 零改动对 Go 跑绿」= cutover 门槛（ADR-0029）。
4. **skills 的 PAT 调用面**——skill 客户端只感知 HTTP 契约，原样保留，零 Go 侧工作。
5. **SQLite schema 与 `__drizzle_migrations` 账本**——零迁移；账本策略 ADR-0026。
6. **环境变量与文件语义**——`WR_AUTH_DISABLED='1'`、`XDG_DATA_HOME`/`XDG_CONFIG_HOME`、`PORT`/`HOSTNAME`、auth.json 存量文件格式与哈希（Go 必须能验证既有部署的存量文件）、preparePassword 预生成。
7. **域语言**——`CONTEXT.md` 术语与 avoid-list 冻结，重写期间不得改名。
8. **唯一 additive 变更**：collect 的两个 `'use server'` action 变为新路由（§5 B4）。

## 3. ADR 索引

| ADR | 主题 | 一行要点 |
|---|---|---|
| [ADR-0025](adr/0025-go-single-binary-datastack.md) | Go 单二进制数据栈 | 仓根 module；sqlc+modernc+chi 配方；embed；`make build` 唯一构建入口 |
| [ADR-0026](adr/0026-migration-ledger-frozen-baseline.md) | 迁移账本 | serve 只读校验 fail-closed；`wr db migrate` 唯一写账本者；切换后手写 SQL + `wr db new` + corpus lint |
| [ADR-0027](adr/0027-ai-engine-adapter-port.md) | AI 客户端与生成引擎 | SDK 只作传输 + 自建 tool-loop；UTF-16 计长、增量 output、marker 协议约束等移植硬约束 |
| [ADR-0028](adr/0028-frontend-spa-vite.md) | 前端 SPA 化 | Vite + RR v7 钉版；next 依赖直接真替换；authEnabled 挂载前探测 |
| [ADR-0029](adr/0029-test-e2e-migration.md) | 测试与 e2e 基建 | 只跑生产单二进制；模式矩阵退役；单测边界=测试跟着代码走；两段式验收 |
| [ADR-0030](adr/0030-construction-order-and-cutover.md) | 施工顺序与切换 | 按域串行 B0–B6、SPA 殿后、cutover 单 PR 无观察期 |

## 4. 目标架构一页

```
仓库根
├── go.mod                  module github.com/dev-zapi/weekly-reporter
├── cmd/wr/                 serve · db (migrate|new)
├── internal/
│   ├── api/                chi 路由，按域分包；trace 全局中间件 + auth 挂 /api
│   ├── db/                 sqlc 生成 + schema.sql（drizzle 语料只读合并视图）
│   ├── engine/             生成引擎（循环、事件、节流落库、stop registry）
│   ├── aiclient/           anthropic / openai-responses / openai-compatible 三 adapter
│   ├── migrate/            账本校验与 applier（embed drizzle/，显式吃 _journal.json）
│   ├── buildinfo/          -ldflags 注入
│   └── trace/
├── web/                    pnpm workspace 包（packages: ['.', 'web']）；vite build → web/dist
├── drizzle/                迁移语料（唯一语料 + 唯一账本 __drizzle_migrations）
├── src/                    客户端源码（SPA 直接消费；服务端层 cutover 时退役）
└── bin/wr                  make build 产物（embed web/dist + drizzle/）

请求流：浏览器 → wr :6868 ─┬─ /api/*（chi，withAuth + audit + trace 响应头）
                           └─ /*（embed 的 SPA，客户端路由）
```

- **`make build`** = `vite build` → `go build -ldflags "-X …buildinfo.CommitHash=… -X …BuildTime=…"`：e2e 与发布共享的唯一入口（ADR-0029 D1）。
- **`wr serve`** 启动：读 env（WR_AUTH_DISABLED/XDG/PORT/HOSTNAME）→ 账本只读校验（fail closed）→ 挂载路由与 embed。
- **`wr db migrate`**：唯一写账本者；`wr db new`：切换后新增迁移的脚手架（tag/idx/when 自动算）。

## 5. 施工批次

每批验收通用式（ADR-0029/0030）：**该域 Go httptest 同用例集全绿 + 全量 e2e 仍指向 Next 跑绿**。批次内的 `route.test.ts` 随批转 Go httptest 并**同 PR 删 vitest 侧**；lib server-only 单测同批走；被 client import 的留 vitest。

### B0 骨架与基建

- **范围**：go.mod（仓根）、`make build`（vite→embed→go build）、合并 `schema.sql`（41 条迁移去反引号，脚本生成不手改）、sqlc 配置与首批公共查询、`wr serve`（账本校验 + health + embed 骨架）、`wr db migrate`、trace/auth(withAuth + PAT + preparePassword 存量验证)/audit 中间件、`internal/buildinfo`。
- **验收**：`bin/wr` 对真实生产 DB 快照启动通过账本校验；health 带 trace 响应头；`wr db migrate` 对已冻结库为 no-op；`make build` 幂等。
- **携带测试**：迁移器单测（含旧式哈希/when 倒挂容错）、guard 单测、trace 中间件单测。

### B1 认证与审计域（4 路由）

- **路由**：`auth/verify`、`auth/pats`、`auth/pats/[id]`、`audit`。

### B2 只读与简单 CRUD 域（9 路由）

- **路由**：`tags`、`tags/rename`、`snippets`、`snippets/[id]`、`events`、`events/heatmap`、`events/[id]`、`events/[id]/references`、`export`。

### B3 计划域（7 路由）

- **路由**：`plans`、`plan-items`、`plan-items/[id]`、`plan-items/[id]/comments`、`plan-items/[id]/comments/[commentId]`、`plan-items/[id]/defer`、`plan-items/[id]/fulfillment`。

### B4 采集域（10 现有 + 2 增补）

- **现有路由**：`collect/sources`、`collect/sources/[id]`、`collect/sources/branches`、`collect/sources/emails`、`collect/sources/lookup`、`collect/sources/bulk-delete`、`collect/sources/bulk-update-scope`、`collect/git-local/fetch`、`collect/git-remote/sync`、`collect/scan-path`。
- **增补路由（唯一 additive，ADR-0030）**：`POST /api/collect/scan-repos`（`{basePath, maxDepth}` → `{repos:[{path,name,alreadyAdded}], error?}`）、`POST /api/collect/batch-add-sources`（`{repos:[{path,name,authorEmails}]}` → `{success, addedCount, error?}`）——1:1 镜像 `src/app/collect/actions.ts` 的两个 server action，返回形状照现状（200 + 内嵌 error 字段），HTTP 层错误只来自 withAuth/audit；路径白名单（HOME//opt//srv//var//tmp）与扫描语义照抄。
- **关键工作**：git 命令移植（exec git，非库绑定）、路径白名单、`expandInputPath`。
- **注**：此二路由在 SPA 批之前无 UI 消费者，httptest/curl 验收。

### B5 模板与 AI 配置域（13 路由）

- **路由**：`templates`、`templates/[id]`、`templates/clone`、`templates/[id]/render`、`prompts/styles`、`prompts/styles/[id]`、`prompts/system`、`settings/ai`、`settings/ai/models`、`settings/ai/test`、`ai/expand-section`、`ai/polish-event`、`ai/unify-style`。
- **关键工作**：`ai/*` 三个 one-shot 走 `internal/aiclient`（adapter 首个消费者，为 B6 引擎热身）；`generateObject` + zod 的 Go 对应物（结构化输出按 provider 各自方式，见 ADR-0027 证据分支 §7）。

### B6 报告与生成引擎域（14 路由）

- **路由**：`reports`、`reports/[id]`、`reports/[id]/final`、`reports/[id]/generate`、`reports/[id]/regenerate-source`、`reports/preview`、`reports/search`、`reports/[id]/generation-sessions`、`reports/[id]/generation-sessions/[sessionId]`、`…/turns`、`…/turns/[turnId]/stop`、`…/proposals/[proposalId]/accept`、`…/query-snapshots/refresh`、`e2e/fixtures`（原样移植，ADR-0029）。
- **关键工作**：`internal/engine` 全量（垂直切片 `prototype/go-gen-engine` 为参照实现：`provider.go` 的 adapter 接口、events、持久化副作用含 audit 归位）；`report-list`/`content` 查询工具全量移植（cursor/legacy/previous_adjacent/grep 预算）。
- **验收加项**：**真实模型端点集成测试必跑**（本地 ai-subscriptions 代理恢复后；垂直切片唯一未覆盖项）；scripted e2e 生成会话 spec 在预切换演练前先对 `Go 守路由 + Next 守页面` 的混合拓扑抽验一轮（垂直切片已验证过该拓扑）。

### B7 SPA 整体迁移（殿后，ADR-0030）

- **范围**：`web/` 进 workspace；15 页全量 + AppShell/AuthGate 等共享树；next 依赖直接真替换（ADR-0028 清单）；build-info 脚本照搬；`ScanReposDialog` 改调两条增补路由。
- **推进方式**：内部按页分 PR（高频页优先：timeline、edit、plans），**整批验收** = `web/` 脱 Next 独立构建全绿 + 对 Go API 全功能跑通 + `src/` 零 `next/*` import。
- **15 页路由表**：与现 `src/app` 页面 1:1（login、timeline、edit/[id]、plans、collect、reports、templates、settings、audit…以 `src/app` 实际目录为准施工时核对）。

### B8 cutover（单 PR，无观察期）

见 §7 runbook。

## 6. 双栈共存期规则（B0–B7 期间）

- **运行时**：生产与日常使用仍走 Next（systemd unit 不动）；Go 以 `go run ./cmd/wr serve` 独立端口驱动开发与 httptest。
- **e2e**：始终指向 Next 生产构建，守护现有行为不回退；Go 侧只以 httptest 验收（ADR-0029 两段式）。
- **dev**：`next dev` 照旧（注意 Next 16 单 dev-server 锁：同目录第二个 `next dev` 拒启，用 `next start -p <port>` 或 DB 快照绕过）；SPA 未开工（串行）。
- **迁移语料**：新增迁移继续 `drizzle-kit generate`（`make migrate` 不变）；`wr db migrate` 可随时对快照库演练。
- **make build**：B0 起即为新链路（vite→embed→go build）；Next 生产构建（`npm run build`）独立保留至 cutover。
- **测试**：vitest 逐批缩容（route.test 随批走），client 面不动；**不新增** TS 侧服务端测试。

## 7. 切换 runbook 与风险登记

### 预切换演练（B8 前置，一次性）

1. `make build` 出 `bin/wr`（发布工件）。
2. `go-server.ts`（接替 `next-server.ts`，只拼命令调 `make build`，超时 2min，env 注入 XDG tmp 根 / `E2E_FIXTURES=1` / `WR_AUTH_DISABLED=1`）指向 `bin/wr`。
3. **全套 e2e（双 config：默认套件 + auth 套件）对 Go 单二进制跑绿，spec 零改动**。不过 = 回 B6/B7 修，不得改 spec。
4. cgroup wrapper 回读 `memory.peak`，与 Next 基线 6.1–6.2G（e2e/next-server.ts 注释）对比记录：内存不劣于即达标；劣于 = 先查再切。

### cutover（单 PR）

1. PR 内容：
   - `weekly-reporter.service`：`ExecStart` → `%h/github/weekly-reporter/bin/wr serve`；`NODE_ENV` 删除；`PORT`/`HOSTNAME`/`XDG_*`/Restart 策略/Security 段原样。
   - e2e 永久指向 Go（`go-server.ts` 转正，`next-server.ts` 删除）。
   - **删除 TS 侧**：`src/app/api/**`、`src/app/collect/actions.ts`、`src/lib` server-only 模块、TS server 测试、next 依赖与 `next.config.*`、`.next` 产物、模式矩阵残件（`E2E_SERVER_MODE`/`E2E_BUNDLER`/`NODE_OPTIONS`/auth.config.ts cwd hack）。
   - **保留**：`drizzle/`（唯一语料+账本）、vitest（client 面）、Node 工具链（playwright/scripted-AI/skills 脚本）、`src/` 客户端代码。
2. 合并后 `make install && make restart`，冒烟：登录（双模式）、时间线、生成会话一轮、accept 落库。
3. 全量 e2e 对线上 Go 实例再跑一轮绿。
4. **回滚** = `git revert <cutover PR>` + `make install && make restart`（TS 侧完整回来）。

### cutover 后即时项（不阻塞切换）

- `E2E_WORKERS` 放开与 `MemoryMax` 收紧：实测 memory.peak 后定，不预承诺（ADR-0029 D6）。
- `make dev` 终态：`make dev-api`（`go run ./cmd/wr serve`）+ `make dev-web`（vite dev，proxy /api → Go）；`make migrate` → 手写 SQL + `make sqlc`（`wr db new` 脚手架 + corpus lint 进 CI）（ADR-0026）。
- code-split / 懒加载优化（非阻塞，ADR-0028）。

### 风险登记

| # | 风险 | 对策 |
|---|---|---|
| 1 | 真实模型端点未跑通（垂直切片唯一未覆盖项，本地 ai-subscriptions 代理宕机） | B6 验收必跑；恢复后立即补跑一轮真实会话 |
| 2 | compat 代理不认 `previous_response_id` | items 回放开关（ADR-0027），配置/探测切换，默认关 |
| 3 | React Router v7 → v8 演进 | 钉 ^7.18.5；盯梢 v8 变更，迁移为独立后续决策 |
| 4 | UTF-16 计长漂移（预算阈值 ×3） | `utf16Len`/`sliceUTF16` helper 进公共包 + 单测覆盖 CJK 边界 |
| 5 | publicSummary nil→null 静默丢弃 | 空 slice 显式初始化 + e2e 结构校验兜底 |
| 6 | cutover PR 巨大 | 原子性是特性（revert 即回滚）；演练前置已验全量 e2e |
