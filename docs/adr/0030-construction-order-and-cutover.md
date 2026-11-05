---
status: accepted
---

# 施工顺序与单 PR 切换：按域串行、SPA 殿后、无观察期

施工按域串行分批，每批验收 = 该域 Go httptest 同用例集全绿 + 全量 e2e 仍指向 Next 跑绿（行为不回退）。后端顺序（CRUD 先行、生成引擎殿后——引擎依赖最多表与两个查询工具的全量移植，风险已被垂直切片消除，早期批次优先验证全链路模板）：B0 骨架（module、make build、schema.sql、迁移器、中间件、health、buildinfo）→ B1 认证+审计 → B2 只读/简单 CRUD（tags/snippets/events/export）→ B3 计划域 → B4 采集域（含 2 条增补路由）→ B5 模板/prompts/settings-ai/ai one-shot → B6 报告+生成引擎+e2e fixtures（真实模型集成测试必跑）。逐批路由清单与验收细节在 `docs/migration-blueprint.md`。

**SPA 整体殿后**：后端 B0–B6 全部完成后整体迁移前端（15 页 + build-info + next 依赖真替换），单轨推进心智负担最小；内部可按页分 PR，整批验收 = web 脱 Next 独立构建 + 对 Go API 全功能跑通。B4 落地的 2 条增补路由（`POST /api/collect/scan-repos`、`POST /api/collect/batch-add-sources`，1:1 镜像现有 server action 的签名与「200 + 业务对象内嵌 error 字段」返回形状，HTTP 层错误只来自 withAuth/audit）在 SPA 批之前无 UI 消费者，以 httptest/curl 验收。

**cutover 单 PR、不设观察期**：预切换演练（全套 e2e 对 Go 单二进制跑绿）→ 同一 PR 内切换 systemd unit（ExecStart → `bin/wr serve`，PORT/HOSTNAME/XDG 同名沿用）+ e2e 永久指向 Go + 全量 e2e 跑绿 + 删除 TS 侧（API 路由、lib server-only、next 依赖与 config、模式矩阵残件、TS server 测试、next-server.ts）。回滚 = git revert 整个 cutover PR，TS 侧完整回来；全量 e2e 零改动跑绿是唯一安全线，不再叠加人工观察期。

## Considered Options

- **引擎前置**（风险早收、原型代码直接续用）vs **殿后**：前置需特批移植查询工具、批次依赖复杂化；风险已被垂直切片消除。
- **表驱动分批**（26 表分 4 组）vs **域驱动**：验收单位须与「一个域的 httptest 全绿」对齐。
- **两轨并行**（SPA 在 B1 后开工，总工期最短）vs **串行**：取串行，单轨心智负担最小。
- **观察期 7 天后退役** vs **同 PR 退役**：取同 PR，原子可 revert；e2e 绿即门槛。

## Consequences

- `docs/migration-blueprint.md` 持有逐批路由清单与 runbook 全文；本 ADR 只锁顺序原则与门槛。
- cutover PR 巨大但原子；退役后发现问题只能前滚修（revert 即回旧栈）。
- 双栈共存期 dev：Next dev 照旧 + `go run ./cmd/wr serve` 独立端口 + httptest 驱动 Go 开发。
- cutover 后 `make dev` 终态 = `make dev-api`（go run）+ `make dev-web`（vite，proxy /api → Go）两个 target。
