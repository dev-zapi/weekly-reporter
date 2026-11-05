---
status: accepted
---

# Go 单二进制数据栈：仓根 module + sqlc + modernc + chi

迁移的运行时终态是一个 Go 单二进制 `wr`：chi 路由 + modernc.org/sqlite（纯 Go，无 CGO）+ sqlc 生成的数据访问 + `go:embed` 内嵌 SPA 产物与迁移语料，`make build`（vite build → go build）为 e2e 与发布共享的唯一构建入口。Go module 放**仓库根**（`module github.com/dev-zapi/weekly-reporter`，新 module 不带 `/v2`）：`go:embed` 无法引用父目录，而迁移语料 `drizzle/`（含显式文件模式才能吃进的 `meta/_journal.json`，embed 默认忽略下划线开头文件）与 SPA 产物 `web/dist` 都在仓根已知位置，embed 包必须能直接触及它们。包布局：`cmd/wr`（`serve`、`db` 子命令）+ `internal/` 按域分包（`api`、`db`、`engine`、`aiclient`、`migrate`、`buildinfo`、`trace`）。

sqlc（经 go.mod `tool` 指令钉版）配方要点，均经实证：合并 41 条迁移为单一 `schema.sql`（去反引号）作 schema 输入；时间戳一律 `int64` Unix **秒**（drizzle `{mode:'timestamp'}` 写秒，映射 `time.Time` 运行期会炸）；可空 JSON 列必须 `pointer: true` 生成 `*json.RawMessage`（全库 7 列，显式非指针 go_type 会 Scan NULL 失败）；动态过滤 `sqlc.narg()` 可用但生成 `interface{}` 需自包；`json_each` 等表值函数不被 sqlc 解析器支持，相关查询手写原生 SQL。modernc DSN 带 `_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)` 对齐 better-sqlite3 默认。chi：trace 中间件全局挂、auth 挂 `/api` 前缀；`middleware.RequestID` v5.5.0 只写 context 不设响应头，trace 响应头自写中间件。构建信息双轨：web 侧脚本照搬（见 ADR-0028），Go 侧 `-ldflags -X` 注入 `internal/buildinfo`（日志与 health 用）。

## Considered Options

- **仓根 module vs `server/` 子目录独立 module**（构建期把 `drizzle/` 与 `web/dist` 拷进 server/）：拷贝引入语料与拷贝的漂移面，embed 模式串也要跟着改；仓根零拷贝零漂移。
- **CGO 驱动（mattn/go-sqlite3）vs modernc.org/sqlite**：纯 Go 换交叉编译与部署简洁，单用户负载下性能差可忽略（基线票已定）。
- **标准库 net/http vs chi**：chi 的路由分组与中间件生态契合 trace/auth 挂载分层（基线票已定）。
- **时间戳映射 `time.Time` vs `int64` 秒**：驱动 Scan 对 INTEGER 时间戳直接失败（#92 实测）。

## Consequences

- 仓库根新增 `go.mod`/`go.sum`/`cmd/`/`internal/`，与长期共存的 Node 工具链（vitest client 面、e2e、skills 脚本）同仓。
- `schema.sql` 是 drizzle 语料的只读合并视图，由脚本重生成，不手改。
- embed 产物（`web/dist`、`drizzle/`）必须留在仓根相对路径内；目录挪动会破坏构建。
- CI 需要 Go 工具链（含 sqlc 生成检查）。
