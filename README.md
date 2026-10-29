# weekly-reporter

**weekly-reporter** 是一个自托管的单用户周报工作台：它持续从你的本地 Git 仓库和 GitHub/GitLab 采集工作事件，汇成可筛选、可标注的时间线，并在你指定的日期范围内为不同受众（领导版 / 个人版）生成周报——先由事件快照确定性地产出原稿，再通过与 AI 的多轮协作会话按模板和风格生成可评审、可保存的终版，让每周周报有据可依、有迹可查。

## 功能特性

- **多源事件采集** — 从本地 Git 仓库和 GitHub/GitLab 同步 commit 事件，按分支维护同步游标，不漏延迟推送的提交
- **时间线** — 事件按工作时间排序展示，支持手动记录、重要标记与 `#标签` 筛选
- **双受众周报** — 同一篇周报分领导版 / 个人版，各自基于独立事件快照生成
- **AI 终版生成** — 以确定性原稿为事实来源，在持久化多轮会话中按模板与风格生成候选终版，经评审确认后才保存；支持历史周报参考
- **模板与提示词管理** — 周报模板、AI 风格、系统提示词与 AI 连接配置全部数据库驱动、可视化编辑

> [!NOTE]
> 本项目仍在开发中，且面向个人使用：未做任何认证与访问限制，仅建议在可信环境（如个人 Linux 服务器）中部署，不要直接暴露到公网。

## 测试资源限制

本项目没有 CI，测试全在本机跑，因此默认就压住资源占用（e2e 曾因并发过高触发 OOM，连累机器上的无关进程）：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `E2E_WORKERS` | `1` | Playwright 并发 worker 数 |
| `E2E_DEV_MEM` | `4096` | Next server 的 `--max-old-space-size`（MB） |
| `E2E_MEM_MAX` | `8G` | 整跑 cgroup 内存硬上限 |
| `E2E_CPU_QUOTA` | `300%` | 整跑 cgroup CPU 配额（3 核） |
| `E2E_SERVER_MODE` | `production` | 设为 `development` 才降级为 `next dev`（见下） |
| `E2E_BUNDLER` | 随 mode | 显式指定 `webpack` / `turbopack`；不设时 production 用 turbopack、development 用 webpack |
| `VITEST_MAX_WORKERS` | `2` | vitest 并发 worker 数 |

`npm run test:e2e` 通过 `scripts/run-e2e.mjs` 把整个测试进程树包进 `systemd-run --user --scope`：撞到上限时 OOM kill 只发生在 scope 内部（测试死、机器活）。机器上没有 `systemd-run` 时自动降级为直接跑 Playwright，config 里的 worker / 堆上限依然生效；`E2E_NO_SCOPE=1` 可强制跳过包装。`npm run test:e2e:ui` 是人工交互模式，不包装。

默认跑法是**生产模式 + Turbopack**：webServer 先 `npm run build`（裸 `next build`，即 Next 16 默认的 Turbopack）再 `next start`。四种组合都在本机 8G `MemoryMax` / `300% CPUQuota` 的 scope 里串行实测过：

| 模式 + 打包器 | 结果 | 耗时 | `memory.peak` |
| --- | --- | --- | --- |
| 生产 + Turbopack（默认） | 25/25 全绿 | 最快 | 6.1–6.2G（有余额） |
| 生产 + webpack | 25/25 全绿 | 慢于 Turbopack | 7.7–8.0G（基本顶满） |
| dev + webpack | 能跑完但一路贴着上限，最慢 | 14m42s | 8.0G 顶满，靠 swap 才没 OOM |
| dev + Turbopack | 8G 下必被 OOM kill（native 内存，`--max-old-space-size` 管不到）；放宽到 12G 才跑完，且 `legacy-migration` 因 Turbopack 冷启动超 30s 超时变红 | — | 12G 也顶满 |

所以默认取「生产 + Turbopack」：既全绿又留了内存余量。两个逃生口：`E2E_SERVER_MODE=development` 显式降级到 `next dev`（该模式下打包器默认回落到 webpack，因为 dev + Turbopack 在上述 scope 里必死），以及 `E2E_BUNDLER=webpack|turbopack`（显式值在两种模式下都优先，升级 Next 后想重测也用它）。显式的 `E2E_SERVER_MODE=production` 仍然接受；未设或非法值一律按 production 处理。生产模式下 webServer 超时放宽到 5 分钟——命令里含一次完整构建。不用 `CI=1` 切换模式是因为 Playwright 也会读它（retries、forbidOnly、workers），会连带改变测试行为；生产模式原本由 `CI` 推断，现在它只是默认值，不再有 `CI` 分支。
