---
status: accepted
---

# 测试与 e2e 基建迁移：只跑生产单二进制，两段式验收

e2e 只跑**生产单二进制**，验收工件 = 发布工件：`go-server.ts`（接替 `next-server.ts`，只拼命令）调用与发布同一个 `make build` 目标（vite build → go build embed），不写 e2e 专属构建脚本；webServer 超时 5min → 2min（vite build 秒级、go build 缓存命中秒级，留冷缓存余量）；env 继续注入 XDG tmp 根 / `E2E_FIXTURES=1` / `WR_AUTH_DISABLED=1`。模式矩阵整体退役：`E2E_SERVER_MODE` / `E2E_BUNDLER` / `NODE_OPTIONS` 堆上限 / webServerTimeout 双档、auth.config.ts 的 cwd hack——存在理由（bundler 四象限内存实测）随 Next 消失；SPA 侧调试 = `vite dev` + 手工 `wr serve` 组合，不进 playwright 配置。

移植与保留边界：`/api/e2e/fixtures` **原样移植 Go**（同路径、同 `{action, marker, …}` 请求/响应形状、`E2E_FIXTURES=1` 门控、withAuth 语义、`database/sql` 直写 DB、DELETE 清理同形）；scripted-AI **留在 Node**（e2e 测试侧资产，非应用代码），其 marker 协议对引擎的约束（`/chat/completions` + 消息形状不变）落在 ADR-0027。auth/env 语义同名同值：`WR_AUTH_DISABLED='1'` boot 读一次；`XDG_DATA_HOME`/`XDG_CONFIG_HOME` 同名沿用（e2e 隔离机制不变）；preparePassword 预生成 hack 保留（auth.json 文件格式与哈希算法被存量数据冻结，Go 必须能验证既有部署的存量文件，TS 同算法预生成继续可用）。cgroup wrapper 原样（MemoryMax 8G / CPUQuota 300% / memory.peak + oom_kill 回读），`memory.peak` 回读兼作「内存不劣于 Next 版」动机的量化验收（Next 生产+Turbopack 基线 6.1–6.2G 峰值，记录于 e2e/next-server.ts 注释）；E2E_WORKERS 放开与 MemoryMax 收紧 = cutover 后实测决策，不预承诺数值。

服务端单测边界：**测试跟着代码走**——33 个 `route.test.ts` → Go httptest 等价测试（同用例集：同 happy path + 同 `{error, code}` 错误形状断言），放 server 侧对应包，随所在域的施工批次走、同 PR 删 vitest 侧；lib 里 server-only 模块（auth guard、db、生成引擎等）→ Go 单测；**被 client 代码 import 的任何东西（zod schema、纯函数、类型）→ 留 vitest**（永久，非过渡）。

验收时点（两段式 + 预切换演练）：施工期（Next 仍为运行时）路由族完工验收 = 仅该域 Go httptest 同用例集全绿，e2e 继续指向 Next 守护现有行为不回退；全部 57 路由移植完成、正式切换之前，runbook 写死一步**预切换演练**——全套 e2e 对 Go 单二进制跑绿；cutover 门槛 = **全量 e2e 零改动对 Go 二进制跑绿**；cutover 后 e2e 永久指向 Go，删除 TS server 测试。

## Considered Options

- **双模式 e2e**（Next+Go 并跑同一套 spec）：模式矩阵刚退役又引回双倍矩阵。
- **e2e 全量先行重写**：spec 零改动是验收红线，重写即失守。
- **fixtures 改走 API 造数**：绕开被测路由本身，失去直写 DB 的确定性。

## Consequences

- `e2e/next-server.ts` 在 cutover PR 由 `go-server.ts` 替代后删除。
- vitest 长期只守 client 面；Node 工具链（playwright、scripted-AI、skills 脚本）长存。
- memory.peak 对比数字进 runbook 作为切换后回归参照。
