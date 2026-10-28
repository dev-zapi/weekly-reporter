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
| `E2E_DEV_MEM` | `4096` | dev server 的 `--max-old-space-size`（MB） |
| `E2E_MEM_MAX` | `8G` | 整跑 cgroup 内存硬上限 |
| `E2E_CPU_QUOTA` | `300%` | 整跑 cgroup CPU 配额（3 核） |
| `E2E_BUNDLER` | `webpack` | `turbopack` 时 dev server 改用 Turbopack（默认 webpack，见下） |
| `VITEST_MAX_WORKERS` | `2` | vitest 并发 worker 数 |

`npm run test:e2e` 通过 `scripts/run-e2e.mjs` 把整个测试进程树包进 `systemd-run --user --scope`：撞到上限时 OOM kill 只发生在 scope 内部（测试死、机器活）。机器上没有 `systemd-run` 时自动降级为直接跑 Playwright，config 里的 worker / 堆上限依然生效；`E2E_NO_SCOPE=1` 可强制跳过包装。`npm run test:e2e:ui` 是人工交互模式，不包装。

dev server 用 `--webpack` 而不是 Next 16 默认的 Turbopack。实测（#64）：8G 上限下 Turbopack 的 `next dev` 在 3 分半就把上限吃穿（native 内存，`--max-old-space-size` 管不到），整跑被 OOM kill 在 16/27；放宽到 12G 能跑完全套，但 `memory.peak` 同样顶满 12G，且 `legacy-migration` 因 Turbopack 冷启动超过该用例 30s 超时而稳定变红（多 1 个失败）。webpack 在 4G 堆下能跑完整套件：25 过 0 红（#63 修复后实测，2m30s；#64 时期的 14m42s 是「7 过 20 红」的失败前置耗时，不具参考性），`memory.peak` 顶到 8G 上限但 `oom_kill=0`（差额由 swap 吸收）。升级 Next 后想重测用 `E2E_BUNDLER=turbopack`。
