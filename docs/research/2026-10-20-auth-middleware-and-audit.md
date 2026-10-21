# 研究：/api/** 认证中间件机制与审计写入点

- **Ticket**: [#50](https://github.com/dev-zapi/weekly-reporter/issues/50)（Part of [#49](https://github.com/dev-zapi/weekly-reporter/issues/49)）
- **日期**: 2026-10-20
- **版本基线**: `next@16.2.9`（`package.json` 与 `node_modules/next/package.json` 一致）、`react@19.2.4`、`better-sqlite3@^12.11.1`
- **方法**: 以 `node_modules/next/dist/docs/` 随包文档 + `node_modules/next/dist/` 随包源码为一手依据；另建一个独立的 Next 16.2.9 最小工程做**运行时实测**（`next build` + `next start` + curl），不以训练数据作答。

> 本文件只回答机制可行性，不推翻 [#49 的 Charter decisions](https://github.com/dev-zapi/weekly-reporter/issues/49)（Round 1–2 grilling 锁定）。

---

## 0. 一句话结论

**推荐 `src/proxy.ts`（Next 16 的新约定）做统一认证拦截器 + 共享 `requireAuth(request)` 守卫函数做逐路由兜底；PAT 审计写在守卫函数里，不写在 proxy 里。** 原因：proxy 在本版本跑 Node.js runtime，可以 import `better-sqlite3`、读文件、读 `process.env`——技术上能写库；但 proxy **在路由处理器之前**执行，拿不到路由最终返回的 HTTP status（实测：路由返回 500 时 proxy 观测到的仍是 200），而 Charter 决策 #11 要求审计表记录 status。

---

## 1. 本版本 middleware 的真名与 runtime

### 1.1 `middleware.ts` 已废弃，改名 `proxy.ts`

> "The `middleware` file convention is deprecated and has been renamed to `proxy`."
> — `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`（文首 Note）

> "Starting with Next.js 16, Middleware is now called Proxy to better reflect its purpose. The functionality remains the same."
> — `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`（## Proxy）

版本历史（同上 `proxy.md`，## Version history）：

| Version | Changes |
| --- | --- |
| `v16.0.0` | Middleware is deprecated and renamed to Proxy. **Proxy defaults to the Node.js runtime** |
| `v15.5.0` | Middleware can now use the Node.js runtime (stable) |

随包文档中**不存在 `middleware.md`**，只有 `proxy.md`；`find node_modules/next/dist/docs -iname "*middleware*"` 无命中（`02-pages/.../proxy.md` 是 Pages Router 的转发壳）。

源码侧确认（`node_modules/next/dist/build/index.js:645-651`）：

```js
throw ... (`Both middleware file ... and proxy file ... are detected. Please use ... only.`)
_log.warnOnce(`The "middleware" file convention is deprecated. Please use "proxy" instead. ...`)
```

即：`middleware.ts` 仍可编译（仅告警），但**本仓库必须用 `proxy.ts`**。

### 1.2 runtime 只有 nodejs，且不可配置

> "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."
> — `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`（## Runtime）

> "The `edge` runtime is **NOT** supported in `proxy`. The `proxy` runtime is `nodejs`, and it cannot be configured. If you want to continue using the `edge` runtime, keep using `middleware`."
> — `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`（## `middleware` to `proxy`）

源码强制点（`node_modules/next/dist/build/analysis/get-page-static-info.js:585-599`）：

```js
if (isProxyFile(page) && resolvedRuntime) {
  const message = `Route segment config is not allowed in Proxy file at "${resolvedPath}". Proxy always runs on Node.js runtime. ...`
  // dev: errorOnce + 强制 resolvedRuntime = 'nodejs'；production: throw E1031
}
```

构建期分层（`node_modules/next/dist/build/entries.js:231-243`）：

```js
if (isProxyFile(params.page)) { params.onServer(); return }        // → Node server 编译
if (isMiddlewareFile(params.page)) {
  if (params.pageRuntime === 'nodejs') { params.onServer(); return }
  else { params.onEdgeServer(); return }                          // → Edge 编译
}
```

**本版本不存在 `experimental.nodeMiddleware` 开关**：`grep -rn "nodeMiddleware" node_modules/next/dist/docs/` 零命中；`node_modules/next/dist/server/config-shared.js` 无该字段。旧版「edge 改 nodejs 要开实验开关」的套路在这里不适用。

### 1.3 ⚠️ 随包文档内部自相矛盾（必须知道）

`node_modules/next/dist/docs/01-app/02-guides/self-hosting.md`（## Proxy）仍写：

> "Proxy uses the [Edge runtime](...), a subset of all available Node.js APIs ... If you do not want this, you can use the full Node.js runtime to run Proxy."

这一段是**过时残留**，与 `proxy.md`（## Runtime）、`version-16.md`（## `middleware` to `proxy`）以及随包源码三方冲突。**以 `proxy.md` + 源码为准（Node.js runtime）**，并已用运行时实测独立验证（见 §3.1）。

---

## 2. matcher 语法：能否覆盖全部 `/api/**`

### 2.1 文档规则

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`（### Matcher）：

> 1. MUST start with `/`
> 2. Can include named parameters: `/about/:path` matches `/about/a` and `/about/b` but **not** `/about/a/c`
> 3. Can have modifiers on named parameters (starting with `:`): `/about/:path*` matches `/about/a/b/c` because `*` is _zero or more_
> 4. Can use regular expression enclosed in parenthesis: `/about/(.*)` is the same as `/about/:path*`
> 5. Are anchored to the start of the path

`source` 字段可用，且支持对象形式 `{ source, locale, has, missing }`（同节）。

### 2.2 结论与实测

**`matcher: '/api/:path*'` 可覆盖全部 `/api/**`**，包括多层嵌套（`/api/reports/42/generation-sessions`）与 `/api` 本身（`*` 匹配零段）。

源码侧 matcher 编译（`node_modules/next/dist/build/analysis/get-page-static-info.js:332` 附近）生成的正则：

```
^(?:\/(_next\/data\/[^/]{1,}))?\/api(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$
```

**运行时实测**（Next 16.2.9 最小工程，`src/proxy.ts` + `matcher: '/api/:path*'`）：

| 请求 | proxy 是否执行 |
| --- | --- |
| `/api/ping` | ✅ |
| `/api/boom`（返回 500） | ✅ |
| `/api/reports/42/generation-sessions` | ✅ |

### 2.3 关键坑：文件位置（`src/` 布局）

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/src-folder.md`：

> "If you're using Proxy, ensure it is placed inside the `src` folder."

**实测**（本仓库用 `src/app` 布局）：

| 放置位置 | 构建输出 | 结果 |
| --- | --- | --- |
| `src/proxy.ts` | `ƒ Proxy (Middleware)` | ✅ 生效 |
| 根目录 `proxy.ts` | **无 `ƒ Proxy` 行** | ❌ **被静默忽略** |

根目录 `proxy.ts` 配 `src/app` 会被**无声吞掉**（build 不报错、不告警），这是个非常隐蔽的坑。**本仓库必须放 `src/proxy.ts`。**

### 2.4 其他 matcher 注意事项

- **无 matcher 时**（同节）："Without a `matcher`, Proxy runs on **every request**, including static files (`_next/static`), image optimizations (`_next/image`), and assets in the `public/` folder." —— 本仓库要保护 `/api/**` 而放过页面/静态资源，**必须显式写 matcher**。
- **matcher 必须是常量**（同节 Good to know）："The `matcher` values need to be constants so they can be statically analyzed at build-time. Dynamic values such as variables will be ignored." —— 不能用变量拼出来。
- **Server Action 会被 matcher 一并覆盖/跳过**（## Execution order）："Server Functions are not separate routes in this chain. They are handled as POST requests to the route where they are used, so a Proxy matcher that excludes a path will also skip Server Function calls on that path." 本仓库 `src/app/collect/actions.ts` 是唯一 `'use server'` 文件，**不在 `/api/**` 下 → 不会被 `/api/:path*` matcher 覆盖**，需要单独留意。

---

## 3. proxy 能力实测：native module / 文件 / env / 同步阻塞

### 3.1 `better-sqlite3` 可在 proxy 中 import 并同步写库 ✅

依据链：
1. proxy = Node.js runtime（§1.2）
2. `better-sqlite3` 在 Next 默认 server-external 列表中：
   > "Next.js includes a short list of popular packages that currently are working on compatibility and automatically opt-ed out: … `better-sqlite3` …"
   > — `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md`（源码佐证 `node_modules/next/dist/lib/server-external-packages.jsonc:33`）
3. proxy 的 webpack layer 属于 `WEBPACK_LAYERS.GROUP.bundled`（`node_modules/next/dist/lib/constants.js:395-403`），因此 `handleExternals` 会走 `isAppLayer` 分支，把 opt-out 包保留为原生 `require`（`node_modules/next/dist/build/handle-externals.js:205-210`）。

**实测**（`next build` + `next start`）：

```
✓ Compiled successfully
ƒ Proxy (Middleware)
```

启动日志：

```
[proxy] wrote audit row, db size: 8192
```

DB 实际落盘并可查：

```
[ { id: 1, ts: 1792484548942, note: 'proxy-hit' } ]
```

即 **proxy 里 `new Database(...)` / `db.prepare(...).run(...)` 同步写库完全可行**，无需 `serverExternalPackages` 额外配置。

### 3.2 读本地文件 / `process.env` / `process.cwd()` ✅

实测 proxy 内：

```ts
const password = JSON.parse(fs.readFileSync(passwordFile, 'utf-8')).password
process.env.WR_AUTH_DISABLED === '1'
process.cwd()  // → /home/god/proxy-test（与 route handler 同一 cwd）
```

三项均正常。`process.env` 另有文档背书（`node_modules/next/dist/docs/01-app/03-api-reference/07-edge.md`，## Environment Variables："You can use `process.env` to access Environment Variables for both `next dev` and `next build`."）。

### 3.3 同步阻塞工作的定性

`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`（## Use cases）：

> "Proxy is _not_ intended for slow data fetching. While Proxy can be helpful for optimistic checks such as permission-based redirects, it should not be used as a full session management or authorization solution."

文档没有禁止同步阻塞，但明确劝退在 proxy 做「完整会话管理」。**Charter 决策 #3 要求 PAT 双模式认证（查库比对 SHA-256）+ #10/#11 要求记审计，proxy 不适合承担完整认证逻辑。**

### 3.4 ⚠️ proxy 观测不到路由的最终 status（决定性约束）

proxy 返回 `NextResponse.next()` 后才轮到路由处理器执行，proxy 拿到的是自己的占位响应。

**实测**：

| 路由实际返回 | 客户端收到 | proxy 观测到的 `res.status` |
| --- | --- | --- |
| `/api/boom` → 500 | `500` | **`200`** |
| `/api/ping` → 200 | `200` | `200` |

而 Charter 决策 #11 规定审计表要有 `status` 字段。**proxy 无法可靠提供该字段**（除非在 proxy 里重放请求，无必要且有副作用）。

### 3.5 proxy 与路由共享同一进程与 DB 连接 ✅

proxy 与 route handler 编译进**同一个 Node 进程**，实测 `globalThis` 单例在两者间共享：

```
[dbtest] created NEW connection     ← proxy 先跑
[proxy] wrote row
[dbtest] reusing existing connection ← route 复用同一连接
```

DB 落盘行：`[{who:'proxy'},{who:'route'}]`，顺序正确、无锁冲突。

> 推论：若在 proxy 里建审计表连接，路由侧再 `getDb()` 不会重复开连接——但**两侧都应复用 `src/lib/db/index.ts` 的 `getDb()` 单例**，不要各写各的。

---

## 4. 替代方案：共享守卫函数逐路由调用

### 4.1 侵入规模

| 指标 | 数量 |
| --- | --- |
| `src/app/api/**/route.ts` 文件数 | **53** |
| 其中含 handler 的文件 | 53（全部） |
| handler 总数 | **82**（GET 29 / POST 30 / PUT 9 / DELETE 11 / PATCH 3） |
| handler 签名形态 | `GET(request: Request)` 为主；含 `{ params }` 的为多行签名 |

### 4.2 能否收敛到「每文件一行」

**能，且不止一行。** 用高阶函数（HOF）包装，每文件只需改**导出行**，handler 本体一行不动。

先例：随包文档自己就是这么推荐的。

> "While Proxy can be useful for initial checks, it should not be your only line of defense in protecting your data. The majority of security checks should be performed as close as possible to your data source, see Data Access Layer for more information."
> — `node_modules/next/dist/docs/01-app/02-guides/authentication.md`（### Optimistic checks with Proxy (Optional)）

> "Treat Route Handlers with the same security considerations as public-facing API endpoints, and verify if the user is allowed to access the Route Handler."
> — 同上（### Route Handlers）

**三种落地形态**（按侵入度递增）：

| 形态 | 每文件改动 | 能拿到最终 status？ | 能记审计？ |
| --- | --- | --- | --- |
| A. `requireAuth(request)` 守卫，在 handler 体内首行调用 | 1 行（`const auth = await requireAuth(request); if (!auth.ok) return auth.response`） | ✅ | ✅ |
| B. `withAuth(handler)` HOF 包住导出 | 1 行（改导出）+ 1 行 import | ✅ | ✅ |
| C. 纯 proxy | 0 行 | ❌ | ⚠️ 无 status |

形态 B 的实测（独立工程，`src/lib/auth-guard.ts`）：

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

type Handler<C = unknown> = (req: NextRequest, ctx: C) => Response | Promise<Response>

export function withAuth<C>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const auth = req.headers.get('authorization')
    if (auth !== 'Bearer supersecret123') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const res = await handler(req, ctx)      // ← 这里能拿到真实 status
    // 审计写入点：res.status / req.method / req.nextUrl.pathname
    return res
  }
}
```

路由侧改动（`src/app/api/ping/route.ts`）：

```ts
import { withAuth } from '@/lib/auth-guard'
export const GET = withAuth(async () => Response.json({ ok: true }))
```

**实测结果**：

| 请求 | 客户端状态 | 日志 |
| --- | --- | --- |
| 无 `Authorization` | `401` | （未进 handler） |
| 带正确 Bearer | `200` | `[guard] saw downstream status = 200` |
| `/api/boom` 带正确 Bearer | `500` | `[guard] saw downstream status = 500` ✅ **拿到了真实 status** |
| `/api/reports/42/generation-sessions` 带 Bearer | `200` | `[guard] saw downstream status = 200`（`{ params }` 透传正常） |

> `withAuth` 形态要处理**签名不统一**问题：本仓库既有 `GET(request: Request)` 也有 `GET(_request, { params })`、还有 3 个无参 `GET()`。HOF 需要让 wrapper 接受可选第二参并透传。
> 形态 A（`requireAuth(request)` 守卫）签名更简单、对既有 handler 形态零约束——**推荐 A 作为主形态，B 作为可选**。

### 4.3 53 个文件 × 1 行的代价评估

- 机械改动，可脚本化（AST 或 `sed` 匹配 `export async function X(` → `export const X = withAuth(async function X(`）。
- 风险点：**漏改**。新增 route 时忘记包 → 该 route 无认证。**必须配一条 CI/测试断言**（例如扫描 `src/app/api/**/route.ts` 断言每个导出 handler 都被 `withAuth` 覆盖），否则会出现「静默失守」。
- 对比 proxy：proxy 天然覆盖新 route，漏改风险为零 —— **这是 proxy 唯一且重要的优势**。

---

## 5. 密码生成时机

### 5.1 文档保证：`register()` 先于首个请求

> "The file exports a `register` function that is called **once** when a new Next.js server instance is initiated, and **must complete before the server is ready to handle requests**. `register` can be an async function."
> — `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`（### `register` (optional)）

同句亦见于 `node_modules/next/dist/docs/01-app/02-guides/instrumentation.md`（## Convention）。

源码链路（保证是由 `await` 强制，而非靠运气）：

1. `node_modules/next/dist/server/next-server.js:492-496` — 构造期即**预热**触发：
   ```js
   // This is just optimization to fire prepare as soon as possible. It will be properly awaited later.
   if (!options.dev) { this.prepare().catch(...) }
   ```
2. `node_modules/next/dist/server/next-server.js:568-573` — `prepareImpl()` → `runInstrumentationHookIfAvailable()` → `ensureInstrumentationRegistered(dir, distDir)`。
3. `node_modules/next/dist/server/base-server.js:467` — **`async handleRequest(req, res, parsedUrl) { await this.prepare(); ... }`** ← 关键：请求处理前必定 await。
4. `node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js:85-91` — `ensureInstrumentationRegistered` 用单个 memoized promise，保证 `register()` 每进程**只跑一次**。
5. 同文件 `:53-56` — `registerInstrumentation` 在 `NEXT_PHASE === 'phase-production-build'` 时**跳过**（即 `next build` 阶段不执行，`next start` 才执行）。

### 5.2 实测

`src/instrumentation.ts` 写入时间戳文件：

```
✓ Ready in 66ms
[instrumentation] register() called at 1792484627539
```

- `register()` 的时间戳 **早于** 第一次 curl 请求（请求时间戳 `1792484637235`，晚约 9.7 秒）；
- 且**早于 "Ready" 日志打印**——即启动阶段就跑完了。

**结论：`next start` 下 `register()` 可靠地先于首个请求执行。** 与 Charter 决策 #1「启动密码：仅当文件缺失/为空时随机生成 48 位，跨重启稳定」契合——密码文件生成可放在 `register()`。

### 5.3 register() vs lazy 生成

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **`register()` 里生成**（推荐） | 启动即有密码，运维可立刻从服务器读；与文档保证一致；本仓库 `instrumentation.ts` 已有 `initializeSnippets()` 先例 | 若 `register()` 抛错会拖住服务器 ready（本仓库现状是 try/catch 吞异常，安全起见**继续 catch 但要记日志**） |
| **首次认证时 lazy 生成** | 无需在启动路径上做任何事 | 首个请求承担生成成本；**若首个请求恰好是「用密码登录」的那个请求，就会出现「拿不到密码」的竞态**；且 password 文件不落盘时运维无法取回密码 |

**推荐 `register()`**。理由：Charter 决策 #1 要求密码跨重启稳定、且是「文件缺失/为空时才生成」——`register()` 天然契合；且实测证明时序可靠。

**混合保险**：认证侧仍应容忍「文件不存在」的情况（返回 401 而不是崩），因为 `register()` 可能被 try/catch 吞掉、或用户手动删了文件。

---

## 6. 现有基础设施确认（审计写入点要复用的部分）

### 6.1 `src/lib/paths.ts` 的 CONFIG_DIR

```ts
const isTest = process.env.NODE_ENV === 'test'
const XDG_CONFIG_HOME = isTest
  ? path.join(os.tmpdir(), 'weekly-reporter-test-config')
  : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))

export const DATA_DIR   = path.join(XDG_DATA_HOME, 'weekly-reporter')
export const CONFIG_DIR = path.join(XDG_CONFIG_HOME, 'weekly-reporter')   // ← ~/.config/weekly-reporter/
export const DB_PATH    = path.join(DATA_DIR, 'reports.db')
```

- `CONFIG_DIR` = `${XDG_CONFIG_HOME}/weekly-reporter`，默认 `~/.config/weekly-reporter/` —— 与 Charter 决策 #1（密码文件在 `~/.config/weekly-reporter/`）和 #8（机器级 PAT `~/.config/weekly-reporter/auth.json`）**完全一致**，无需改动。
- 已有 `ensureDataDir()`（只保 `DATA_DIR`），**没有 `ensureConfigDir()`** —— 写密码文件时需新建。
- 测试环境重定向到 `os.tmpdir()/weekly-reporter-test-config`（Charter 决策 #4「测试引导统一设 env」可依赖此机制）。
- 注意：`paths.ts` **没有** `import 'server-only'`，但它用了 `fs`/`os`/`path`，**只能在 Node runtime 用**——proxy 是 Node runtime，可以用；Edge 则不行。

### 6.2 `src/lib/db/index.ts` 的自动迁移

```ts
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
  if (!db) {
    ensureDataDir()
    const sqlite = new Database(DB_PATH)
    try {
      applyDatabaseMigrations(sqlite, path.join(process.cwd(), 'drizzle'))
      db = drizzle(sqlite, { schema })
    } catch (error) {
      sqlite.close()
      throw new Error('Database migration failed', { cause: error })
    }
  }
  if (!db) throw new Error('Database initialization failed')
  return db
}
```

`applyDatabaseMigrations`（`src/lib/db/migrations.ts`）流程：
1. `CREATE TABLE IF NOT EXISTS __drizzle_migrations (...)`
2. `reconcileLegacyMigrations(...)` —— 处理历史部分应用的迁移
3. `migrate(drizzle(sqlite), { migrationsFolder })` —— drizzle-kit 正式迁移

**关键点**：
- 迁移目录是 `path.join(process.cwd(), 'drizzle')` —— **相对 cwd**。实测 proxy 与 route handler 的 `process.cwd()` 相同（§3.2），所以 proxy 里调 `getDb()` 也能找到迁移目录。✅
- `getDb()` 是**模块级单例**（`let db`），首次调用时自动建库 + 跑迁移。审计表只需作为一张新表加进 `src/lib/db/schema.ts` + 一份 drizzle 迁移 SQL，**审计写入路径即可复用 `getDb()`，迁移自动生效**。
- 当前最新迁移 = `drizzle/0036_right_impossible_man.sql`（journal idx 36）；`src/lib/db/schema.ts` 有 22 张 `sqliteTable`。
- `DB_PATH` = `${DATA_DIR}/reports.db`（默认 `~/.local/share/weekly-reporter/reports.db`），**与 `CONFIG_DIR` 分离**——密码文件在 config 目录，审计表在 DB。

### 6.3 审计写入点的复用建议

审计写入应放在**认证守卫函数**里（形态 A/B），并复用 `getDb()`：

```
认证守卫（Node runtime，route handler 内）
  ├─ 读 CONFIG_DIR 下的密码文件 + PAT 表
  ├─ 校验 Bearer（浏览器密码 或 PAT）
  ├─ 若是 PAT 调用 → 写审计行到 DB（经 getDb()，复用同一连接与迁移）
  └─ 更新 PAT 的 last_used_at
```

这样一次调用同时完成：认证、PAT last_used_at、审计落库——三者共享同一个 `getDb()` 连接，无额外连接开销。

---

## 7. 风险清单

| # | 风险 | 等级 | 说明与缓解 |
| --- | --- | --- | --- |
| R1 | **proxy 拿不到最终 HTTP status** | 高 | 实测证实（§3.4）。审计表需要 status → **审计不能写在 proxy**，须写在守卫函数内 |
| R2 | **守卫函数逐 route 接入会漏改** | 高 | 53 文件机械改动，新 route 可能忘记包 → 静默失守。**必须加 CI 断言**：扫描 `src/app/api/**/route.ts`，断言每个导出的 HTTP handler 都经过 `withAuth`/`requireAuth` 包装 |
| R3 | **proxy 文件位置静默失效** | 中 | `src/app` 布局下根目录 `proxy.ts` 被无声忽略（§2.3）。**必须是 `src/proxy.ts`**，并在 build 输出确认出现 `ƒ Proxy (Middleware)` 行 |
| R4 | **随包文档 self-hosting.md 段落过时** | 中 | 该段仍称 proxy 用 Edge runtime，与 `proxy.md` + 源码冲突（§1.3）。**以 `proxy.md` 与源码为准**；实现时不要照抄 self-hosting 那段 |
| R5 | **proxy 里同步 SQLite 写入拖慢每个请求** | 中 | proxy 每次命中都写库，串行化在请求关键路径上。且 16.2 的 proxy 已是 Node runtime，无「edge 快路径」可选。→ 进一步支持「proxy 只做乐观拦截，审计写库放守卫」 |
| R6 | **`WR_AUTH_DISABLED` 未生效导致锁死** | 中 | 若 `WR_AUTH_DISABLED=1` 的读取路径有误，用户将无法访问自己的系统。**必须在 proxy 与守卫两处都读同一个 env**，并有 e2e 用例覆盖 |
| R7 | **密码文件写入失败被吞** | 中 | `instrumentation.ts` 现状是 `try/catch` + `console.error`。若密码生成失败被吞，首个认证请求会拿到「无密码」→ 401 锁死。→ 认证侧必须容忍文件缺失（401 而非 500），且日志要显眼 |
| R8 | **proxy 与 route 各自的 DB 连接** | 低 | 实测共享同一 `globalThis` 单例（§3.5）。但**必须两边都走 `getDb()`**，不要在 proxy 里另开 `new Database()`，否则迁移与连接管理会分叉 |
| R9 | **Server Action 不在 `/api/**` 下** | 低 | `src/app/collect/actions.ts` 是唯一 `'use server'` 文件，`/api/:path*` matcher 覆盖不到。→ 需在规格里明确 Server Action 是否受保护（Charter 只说保护 `/api/**`，则按字面不保护，但要显式记录这个已知边界） |
| R10 | **认证失败的 401 形态** | 低 | 浏览器调用与脚本调用的失败响应需统一。`NextResponse.json({ error: 'Unauthorized' }, { status: 401 })` 即可；登录页拦截靠 Charter 决策 #5 的 `GET /api/auth/verify` 探测 |

---

## 8. 推荐方案（供规格 ticket 引用）

### 8.1 分层：proxy 乐观拦截 + 守卫函数权威校验

```
请求
  ↓
src/proxy.ts                matcher: '/api/:path*'
  ├─ 读 process.env.WR_AUTH_DISABLED → 命中则直接放行
  ├─ 无 Authorization 头 → 立刻 401（省掉路由开销，挡住明显未认证流量）
  └─ 有头 → 放行给路由
  ↓
route handler（守卫函数内）
  ├─ requireAuth(request)   ← 权威判定：浏览器密码 或 PAT
  ├─ PAT 命中 → 写审计行（经 getDb()）+ 更新 last_used_at
  └─ 浏览器密码命中 → 不写审计（Charter 决策 #10）
```

**这样分工的理由**：
- proxy 负责「早拒 + 全覆盖」（R2 漏改风险的兜底：即使某个 route 忘了包装，proxy 也会挡掉**完全无凭证**的请求；只有「带错凭证」的请求会漏到路由层）；
- 守卫函数负责「权威判定 + 审计」（R1：只有它能拿到真实 status、真实 PAT 身份）。

### 8.2 具体落地要点

1. **新建 `src/proxy.ts`**（注意是 `src/` 下，不是根目录）：
   ```ts
   export const config = { matcher: '/api/:path*' }   // 常量，不能用变量
   ```
   build 后**必须**看到 `ƒ Proxy (Middleware)` 出现在路由表里。

2. **新建 `src/lib/auth/`** 模块（建议 `server-only`）：
   - `password.ts` — 读 `CONFIG_DIR` 下的密码文件（JSON），首次缺失时生成 48 位
   - `pat.ts` — PAT 的 SHA-256 哈希比对、`last_used_at` 更新
   - `guard.ts` — 导出 `requireAuth(request)`（形态 A）与可选 `withAuth(handler)`（形态 B）
   - `audit.ts` — 写审计行，复用 `getDb()`

3. **审计表**加进 `src/lib/db/schema.ts` + 新一份 drizzle 迁移（接在 `0036` 之后），字段按 Charter 决策 #11：时间、PAT 名称、HTTP method、API path、status、User-Agent、agent 自报身份头、调用方自报 cwd。

4. **密码生成放 `instrumentation.ts` 的 `register()`**（实测时序可靠，§5）：
   ```ts
   export async function register() {
     if (process.env.NEXT_RUNTIME === 'nodejs') {
       try {
         const { ensureStartupPassword } = await import('./src/lib/auth/password')
         await ensureStartupPassword()
       } catch (error) {
         console.error('Failed to initialize startup password:', error)
       }
     }
   }
   ```
   沿用本仓库现有 `initializeSnippets()` 的写法与 try/catch 形态。

5. **加 CI 断言**（R2）：扫描 `src/app/api/**/route.ts`，每个导出的 HTTP handler 必须被认证包装；否则失败。

---

## 9. 引用的一手来源

### 随包文档（`node_modules/next/dist/docs/`）

| 路径 | 用到的章节 |
| --- | --- |
| `01-app/03-api-reference/03-file-conventions/proxy.md` | 文首 Note（middleware→proxy 废弃改名）、### Matcher（source 规则 / 常量要求 / 无 matcher 的默认行为）、## Execution order（Server Function 警告）、## Runtime（Node.js runtime、runtime 选项会抛错）、## Version history（v16.0.0 默认 Node.js）、### Producing a response（`/api/:function*` 范例） |
| `01-app/01-getting-started/16-proxy.md` | ## Proxy（Next 16 改名）、## Use cases（不宜做完整会话管理） |
| `01-app/02-guides/upgrading/version-16.md` | ## `middleware` to `proxy`（edge 不支持、runtime 不可配） |
| `01-app/03-api-reference/03-file-conventions/instrumentation.md` | ### `register` (optional)（must complete before the server is ready）、### Specifying the runtime |
| `01-app/02-guides/instrumentation.md` | ## Convention（同一句保证）、## Importing runtime-specific code |
| `01-app/02-guides/authentication.md` | ### Optimistic checks with Proxy (Optional)（Tips 三条 + 「不应作为唯一防线」）、### Route Handlers、### Creating a Data Access Layer (DAL) |
| `01-app/02-guides/data-security.md` | ### Authentication and authorization、### Using a Data Access Layer for mutations、## Auditing（proxy.ts 与 route.ts 需要重点审计） |
| `01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md` | 默认 opt-out 列表含 `better-sqlite3` |
| `01-app/03-api-reference/03-file-conventions/src-folder.md` | 「If you're using Proxy, ensure it is placed inside the `src` folder」 |
| `01-app/03-api-reference/03-file-conventions/route.md` | ### Parameters（params 是 Promise）、## Segment Config Options、## Version History（v15.0.0-RC GET 默认动态） |
| `01-app/03-api-reference/07-edge.md` | ## Unsupported APIs（Edge 限制，proxy 已不适用）、## Environment Variables |
| `01-app/02-guides/self-hosting.md` | ## Proxy —— **该段与 proxy.md 冲突，以 proxy.md 为准**（见 R4） |
| `01-app/02-guides/backend-for-frontend.md` | ## Proxy（`matcher: '/api/:function*'` + 401 范例） |

### 随包源码（`node_modules/next/dist/`）

| 路径 | 关键行 | 用途 |
| --- | --- | --- |
| `build/analysis/get-page-static-info.js` | 585-599 | proxy 中设 `runtime` → 抛 E1031 |
| `build/analysis/get-page-static-info.js` | 332 附近 | matcher → 正则编译 |
| `build/entries.js` | 231-243 | proxy → Node server 编译；middleware → Edge/Node 分流 |
| `build/index.js` | 613-654 | middleware/proxy 文件发现与废弃告警、两者共存报错 |
| `build/index.js` | 1501-1540 | `functionsConfigManifest.functions['/_middleware'] = { runtime: 'nodejs', matchers }` |
| `build/webpack-config.js` | 490-503, 1094-1100 | middleware webpack layer（proxy 走 Node 编译） |
| `lib/constants.js` | 289-290, 373-412 | `PROXY_FILENAME`、WEBPACK_LAYERS（middleware 属 bundled 组） |
| `lib/server-external-packages.jsonc` | 33 | `better-sqlite3` 在默认 opt-out 列表 |
| `build/handle-externals.js` | 205-210 | bundled layer → opt-out 包保持原生 require |
| `server/next-server.js` | 492-496, 568-573 | 构造期预热 prepare()；prepareImpl → runInstrumentationHookIfAvailable |
| `server/base-server.js` | 467 | `handleRequest` 内 `await this.prepare()` ← 时序保证 |
| `server/lib/router-utils/instrumentation-globals.external.js` | 52-91 | register 只跑一次；build 阶段跳过 |
| `server/web/adapter.js` | 199 | Edge 沙箱下 `waitUntil` 的分支 |

### 仓库内一手代码

| 路径 | 内容 |
| --- | --- |
| `package.json` | `next@16.2.9`、`better-sqlite3@^12.11.1` |
| `instrumentation.ts` | 现有 `register()` + `initializeSnippets()` 先例 |
| `src/lib/paths.ts` | `CONFIG_DIR` / `DATA_DIR` / `DB_PATH` 定义 |
| `src/lib/db/index.ts` | `getDb()` 单例 + 自动迁移 |
| `src/lib/db/migrations.ts` | `applyDatabaseMigrations()` |
| `src/app/api/**/route.ts` | 53 文件 / 82 handler 现状 |
| `src/app/collect/actions.ts` | 唯一 `'use server'` 文件（不在 `/api/**`） |
| `src/lib/plan-references/db.ts` | 本仓库既有 `import 'server-only'` 的 DAL 写法先例 |

### 运行时实测

独立 Next 16.2.9 最小工程（`next build` + `next start` + curl），验证：proxy 走 Node runtime、`better-sqlite3` 可 import 且同步写库成功、`fs`/`process.env`/`process.cwd()` 可用、proxy 观测不到路由真实 status、守卫函数可拿到真实 status、`src/proxy.ts` 与根目录 `proxy.ts` 的生效差异、`register()` 早于首个请求、proxy 与 route 共享 DB 连接单例。
