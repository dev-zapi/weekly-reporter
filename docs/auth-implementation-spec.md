# 认证 + PAT + 机器级凭据 + 审计 —— 实现规格

> 本文件是 [Wayfinder map #49](https://github.com/dev-zapi/weekly-reporter/issues/49) 的落笔产物。
> 决策来源：map Notes 的 16 条 Charter decisions（Round 1–2 grilling 锁定）+ [#50 研究结论](https://github.com/dev-zapi/weekly-reporter/issues/50)（`docs/research/2026-10-20-auth-middleware-and-audit.md`）+ 本轮 4 项拍板。
> 本文件是**规格**，不是实现。服务端代码与 skill 脚本适配由后续 dev session 执行。

## 0. 术语与前提

| 术语 | 定义 |
| --- | --- |
| **启动密码** (Startup Password) | 服务端首次启动时随机生成、写入 `~/.config/weekly-reporter/auth.json` 的 48 位字符串。是浏览器端唯一的登录凭据。 |
| **PAT** (Personal Access Token) | 服务端签发的、给**脚本 / agent** 使用的 API 访问令牌。服务端只存 SHA-256 哈希，明文仅创建时显示一次。 |
| **机器级凭据** (Machine Credential) | 一台机器上「用哪个 PAT、打哪个服务」的配置，落盘在 `~/.config/weekly-reporter/auth.json` 的 `machine` 字段。 |
| **审计记录** (Audit Record) | 一次经 PAT 鉴权的 API 调用留下的痕迹，写在数据库新表 `api_audit_log`。 |

### 0.1 关键前提（来自 #50 实测）

- 本仓库 Next.js 版本是 **16.2.9**。该版本 `middleware.ts` 已废弃改名 **`proxy.ts`**，且 **proxy 恒为 Node.js runtime**（`runtime` 选项会抛错），因此可以 `import 'better-sqlite3'`、读 `fs`、读 `process.env`。
- `src/app` 布局下**必须放在 `src/proxy.ts`**。放根目录 `proxy.ts` 会被**静默忽略**（build 无报错无告警）。
- `matcher: '/api/:path*'` 覆盖全部 `/api/**`（含多层嵌套与 `/api` 本身），但 **matcher 必须是常量**。
- **proxy 观测不到路由的最终 HTTP status**（实测：路由返回 500 时 proxy 观测到 200）。故审计不写在 proxy。
- `instrumentation.ts` 的 `register()` **可靠地先于首个请求**执行（`base-server.js` 在 `handleRequest` 内 `await this.prepare()`），故密码生成放这里。

### 0.2 本轮拍板（4 项，补充 Charter）

| # | 决定 | 理由 |
| --- | --- | --- |
| D1 | 守卫用 **`withAuth(handler)` HOF** 包住导出（不是 `requireAuth` 首行） | HOF 在 handler 返回后能拿到**真实 `res.status`**，Charter #11 的审计 `status` 字段才有正确值；`requireAuth` 首行形态拿不到。 |
| D2 | 新 ADR **引用** ADR-0015，不修改 ADR-0015 原文 | ADR 是不可变的决策记录；正文说明「PAT 审计收窄了 ADR-0015 接受的审计缺口」。 |
| D3 | configure-pat skill 装在**仓库内 `skills/configure-pat/`** | 与其余 10 个 skill 并列、随仓库版本化；与 vendored `client.mjs` 的自包含策略一致。 |
| D4 | **认证失败的尝试也记审计**，只要能认出是哪个 PAT | 脚本 PAT 失效/被吊销是 PAT 场景最常见故障，不记则排障无迹可寻。失败行 `status=401`，`pat_name` 可空。 |

> D4 **扩展**了 Charter #10 的字面范围（原文只说「仅 PAT 调用记审计」）。这是本轮用户明说的偏离，不再是待决问题。

---

## 1. 服务端规格

### 1.1 文件布局

```
src/proxy.ts                    ← Next 16 的统一拦截器（注意在 src/ 下）
src/lib/auth/
  password.ts                   ← 启动密码读写与生成
  pat.ts                        ← PAT 哈希、比对、CRUD、last_used_at
  guard.ts                      ← withAuth / requireAuth
  audit.ts                      ← 审计行写入
  identity.ts                   ← agent 身份头解析（服务端侧）
  types.ts                      ← 共享类型
src/lib/db/schema.ts            ← + apiAuditLog 表
drizzle/0037_*.sql              ← 审计表迁移（接在 0036 之后）
src/app/api/auth/
  verify/route.ts               ← GET，轻量校验
  pats/route.ts                 ← GET(list) / POST(create)
  pats/[id]/route.ts            ← DELETE(revoke)
src/app/api/audit/route.ts      ← GET，审计列表（分页）
src/app/security/page.tsx       ← 安全页（PAT 管理 + 审计两区块）
```

### 1.2 启动密码（Charter #1）

**文件**：`~/.config/weekly-reporter/auth.json`，`CONFIG_DIR` 由 `src/lib/paths.ts` 提供，**无需改动**（已验证 = `${XDG_CONFIG_HOME}/weekly-reporter`，默认 `~/.config/weekly-reporter`）。需要新增 `ensureConfigDir()`（现只有 `ensureDataDir()`）。

**文件格式**（单个 JSON 文件承载启动密码与机器级凭据，见 §3）：

```json
{
  "password": "<48 位随机串>",
  "machine": {
    "baseUrl": "http://localhost:6868",
    "pat": "wrp_..."
  }
}
```

**生成规则**：

- 仅当文件**缺失**或 `password` 字段**缺失/为空**时生成；已存在则**跨重启稳定**。
- 长度 **48** 位，字符集 `A-Za-z0-9`（避免 shell / URL 编码问题）。
- 用 `crypto.randomBytes` 生成，取足够熵。
- 文件权限 `chmod 600`；目录 `ensureConfigDir()` 建 `0700`。
- **重置 = 删除该文件后重启服务**（不提供独立重置命令）。
- 密码**明文存盘**（单用户个人系统，威胁模型是「别人拿到这台机器的磁盘」）。与 PAT 的处理不同——PAT 面向会跨机器传递的脚本凭据。

**生成时机**：放在 `instrumentation.ts` 的 `register()`：

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { initializeSnippets } = await import('./src/lib/init-snippets')
      await initializeSnippets()
    } catch (error) {
      console.error('Failed to initialize built-in snippets:', error)
    }
    try {
      const { ensureStartupPassword } = await import('./src/lib/auth/password')
      await ensureStartupPassword()
    } catch (error) {
      // 认证侧必须容忍密码文件缺失（返回 401 而非 500），故此处只记日志不抛出
      console.error('Failed to initialize startup password:', error)
    }
  }
}
```

沿用现有 `initializeSnippets()` 的 try/catch 形态。**注意**：`register()` 的错误被吞 → 首个认证请求会拿到「无密码」→ 401 锁死。缓解见 §1.7。

**认证侧容错**：密码文件不存在 / 损坏 / 读失败时，`requireAuth` 一律返回 **401**（不是 500），绝不崩。

### 1.3 认证守卫（Charter #2 #3，D1）

**双模式**：`Authorization: Bearer <token>`，token 或是**启动密码**（浏览器）或是 **PAT**（脚本）。

**判定顺序**（`requireAuth(request)`）：

1. `WR_AUTH_DISABLED === '1'` → 直接放行（`auth.ok = true`，`mode = 'disabled'`，**不写审计**）。
2. 取 `Authorization` 头。无 / 非 `Bearer ` 前缀 → 401。
3. 比对**启动密码**：与 `auth.json` 的 `password` 做**常量时间比较**（`crypto.timingSafeEqual`，长度不等时先比 hash 防长度侧信道）→ 命中则 `mode = 'password'`（浏览器调用，**不写审计**，Charter #10）。
4. 比对 **PAT**：对 token 取 SHA-256，在 `api_tokens` 表里查 `token_hash` → 命中则检查吊销状态与过期时间：
   - 已吊销 → 401（**记审计**，`status=401`，D4）。
   - 已过期 → 401（**记审计**，`status=401`，D4）。
   - 有效 → `mode = 'pat'`，`patName = 该 PAT 的名称`，更新 `last_used_at`，**记审计**。
5. 都不命中 → 401（**记审计**，`pat_name` 为空 —— 无法从错误 token 反查是哪个 PAT）。

**`withAuth` HOF（D1，审计 status 的关键）**：

```ts
// src/lib/auth/guard.ts
import { NextResponse } from 'next/server'

type Handler<C = unknown> = (req: Request, ctx: C) => Response | Promise<Response>

export function withAuth<C>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const auth = await requireAuth(req)
    if (!auth.ok) return auth.response        // 401，审计在 requireAuth 内已写
    const res = await handler(req, ctx)       // ← 真实 status 在这里
    await recordAudit(req, res.status, auth)  // ← 只有 PAT 模式才真正落库
    return res
  }
}
```

**与现有 handler 签名的兼容性**（实测复核：53 文件 / **82 handler**，形态分布为 **单参 35 / 双参 37 / 无参 10**）：

| 现有形态 | 数量 | `withAuth` 改造 |
| --- | --- | --- |
| `export async function GET(request: Request)` | 35 | `export const GET = withAuth(async function GET(request: Request) {...})` |
| `export async function GET(request: Request, { params }: {...})` | 37 | `export const GET = withAuth(async function GET(request: Request, ctx: {...}) {...})` —— **第二参数原样透传，不动其类型** |
| `export async function GET()` （无参） | 10 | `export const GET = withAuth(async function GET() {...})` |

> **与 #50 研究报告的出入**：#50 记的是「3 个无参 `GET()`」，本次逐文件复核为 **10 个**（分布在 `prompts/styles`、`prompts/system`、`settings/ai`（3 个）、`settings/ai/models`、`settings/ai/test`、`tags`、`templates`、`templates/[id]/render`、`timeline/plans`）。以本规格的实测数为准。

> ⚠️ **无参 handler 的一个后果**：无参 handler 拿不到 `Request`，因此**无法读取 `Authorization` 头**。`withAuth` 包装后，它们从 wrapper 收到 `req` 再传给 handler——但 handler 签名是 `function GET()`，**接不到 `req`**。因此 wrapper 必须**自己**完成认证判定（它拿得到 `req`），这正是 `withAuth` 的设计：`requireAuth(req)` 在 wrapper 内执行，与 handler 签名无关。**无参 handler 不需要改签名。**

> **关键约束**：`ctx` 里的 `params` 在 Next 16 是 `Promise`（`route.md` ### Parameters），改造时**不得解包、不得改变其类型**——原样透传给原 handler 即可。

**流式响应**：本仓库当前**没有**返回 `ReadableStream` 的 API route（`src/app/api/**` 全量搜索无命中），故 `withAuth` 只需处理普通 `Response`。**若将来新增流式路由**，`await handler(...)` 返回的 `res.status` 仍是最终状态码（流未消费不影响 status），`withAuth` 无需改动。

**每文件改动量**：**2 行**（1 行 import + 1 行导出行），handler 本体一行不动。共 53 个文件。

### 1.4 `src/proxy.ts`（乐观拦截，兜底漏改）

```ts
// src/proxy.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const config = {
  matcher: '/api/:path*',   // 常量，不能用变量拼
}

export function proxy(request: NextRequest) {
  if (process.env.WR_AUTH_DISABLED === '1') return NextResponse.next()

  // 早拒：完全没有凭证的请求，不进路由（省开销 + 兜底「漏改 route」）
  if (!request.headers.get('authorization')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}
```

**职责边界**（重要）：

- proxy **只做早拒**：无 `Authorization` 头 → 401。有头 → **一律放行**，不在 proxy 里校验 token。
- proxy **不写审计**（拿不到真实 status，#50 实测）。
- proxy **不做权威判定**（Charter #3 要求双模式 PAT 比对 = 查库 + SHA-256，proxy 不适合承担完整认证逻辑）。

**proxy 的唯一价值**：某个 route 忘记包 `withAuth` 时，**完全无凭证**的请求仍会被挡。只有「带错凭证」的请求会漏到路由层 —— 但那时路由层若无 `withAuth`，请求会**成功执行**。因此 §1.7 的 CI 断言是必须的，proxy 不能替代它。

**build 校验**：构建后必须能在路由表里看到 `ƒ Proxy (Middleware)` 行。**没有这一行 = proxy 没生效**（放错位置会被静默忽略）。

### 1.5 PAT（Charter #6 #7）

**数据表** `api_tokens`（加进 `src/lib/db/schema.ts` + 一份 drizzle 迁移）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer PK autoincrement | |
| `name` | text notnull | 用户给的名称 |
| `token_hash` | text notnull unique | **SHA-256 十六进制** |
| `prefix` | text notnull | 明文前 8 位，仅供 UI 辨识（非秘密） |
| `created_at` | integer notnull | |
| `last_used_at` | integer nullable | |
| `expires_at` | integer nullable | **null = 永久有效** |
| `revoked_at` | integer nullable | **null = 未吊销** |

**明文格式**：`wrp_` + 32 位 base62（`crypto.randomBytes`）。`prefix` 存前 8 位（如 `wrp_a1b2`）。

**创建流程**：

1. `POST /api/auth/pats`，body `{ name, expiresAt?: number }`。
2. 服务端生成明文 token → 计算 SHA-256 → 存 `token_hash` + `prefix`。
3. **明文只在这次响应里返回一次**（`{ id, name, token, createdAt }`），之后任何接口都取不回来。
4. UI 必须明确提示「只显示一次，请立即保存」。

**吊销**：`DELETE /api/auth/pats/[id]` → 置 `revoked_at`，**不删行**（保留审计可追溯性）。吊销后该 token 立即失效。

**过期**：默认永久（`expires_at = null`）。创建时可指定；过期 token 视为无效（401 + 记审计）。

**不做权限 scope**（Charter #6）：一个 PAT 拥有全部 `/api/**` 权限。理由：单用户系统，唯一的使用者是自己的 agent，scope 带来的复杂度换不来收益。

**`last_used_at`**：每次 PAT 鉴权成功时更新（同一请求内与审计行共用同一个 `getDb()` 连接）。

**列表**：`GET /api/auth/pats` 返回全部 PAT 的元数据（**不含** `token_hash`、不含明文），含 `revoked_at` / `expires_at` / `last_used_at`。

### 1.6 审计（Charter #11 #12 #13，D4）

**数据表** `api_audit_log`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer PK autoincrement | |
| `created_at` | integer notnull | 调用时间（epoch ms） |
| `pat_name` | text nullable | PAT 名称；浏览器调用为 null；认不出 PAT 的失败也为 null |
| `method` | text notnull | HTTP method |
| `api_path` | text notnull | **接口** = endpoint 路径（如 `/api/events`） |
| `status` | integer notnull | 最终 HTTP status |
| `user_agent` | text nullable | `User-Agent` 请求头 |
| `agent_identity` | text nullable | **Agent** = 调用方自报身份头（见 §1.6.1） |
| `caller_cwd` | text nullable | **路径** = 调用方自报的 cwd（可空） |
| `outcome` | text notnull | `success` / `unauthorized`（便于筛选） |

**记录时机与粒度**：

- **只记 PAT 调用**（Charter #10）。浏览器（启动密码）调用**不记**。
- **失败也记**（D4）：`status = 401` 的 PAT 尝试记一行，`outcome = 'unauthorized'`。`pat_name` 尽可能填（能认出是哪个 PAT 但已吊销/过期时填得上；token 完全错误时填不上，为 null）。
- **写入时机**：在 `withAuth` 内，`await handler(...)` **之后**（拿到真实 status）。`requireAuth` 内部的失败路径（401）就地写。
- **全量保留，不清理**（Charter #12）。

**性能**：`recordAudit` 是同步 SQLite 写（`better-sqlite3`）。走 `getDb()` 单例（与 `src/lib/db/index.ts` 复用同一连接 + 自动迁移）。**不额外开连接**。

> ⚠️ 审计写失败**不得影响业务响应**：`recordAudit` 内部 try/catch，失败只 `console.error`。审计是辅助信息，不该让用户的 API 调用变成 500。

#### 1.6.1 自报身份机制（Charter #13）

**全自动，agent 会话零配合**。skill 脚本在发请求时附带两个自报头：

| 头 | 值 | 来源 |
| --- | --- | --- |
| `X-Weekly-Reporter-Agent` | skill 名 **写死** + agent 名 | skill 名由脚本内常量写死；agent 名从环境推断 |
| `X-Weekly-Reporter-Cwd` | `process.cwd()` | 脚本运行时的工作目录 |

**agent 名推断表**（从环境变量推断，认不出降级 `unknown`）：

| 环境变量 | 推断出的 agent 名 |
| --- | --- |
| `CLAUDECODE` / `CLAUDE_CODE` | `claude-code` |
| `CODEX_SANDBOX` / `CODEX_HOME` | `codex` |
| `OPENCODE` / `OPENCODE_BIN` | `opencode` |
| `CURSOR_TRACE_ID` | `cursor` |
| `ZELLIJ` | `zellij`（注意 zellij 只是终端多路复用器，实际 agent 在上层，**降级 unknown** 更诚实） |
| 其余 | `unknown` |

> **设计取舍**：`zellij` 刻意**不**映射到任何 agent 名——它只说明「跑在 zellij 里」，不说明是谁。降级 `unknown` 比猜错更诚实。

**服务端**：`api_path` 取自请求 URL path；`caller_cwd` 取 `X-Weekly-Reporter-Cwd` 头；`agent_identity` 取 `X-Weekly-Reporter-Agent` 头。**两者都不可信**（调用方自报），仅作归因线索，不作安全依据。

### 1.7 保护范围与总开关（Charter #3 #4）

**保护范围**：**全部 53 个 `/api/**` route 文件**（含新加的 `/api/auth/**`、`/api/audit`）。

**不设防**：页面 HTML、静态资源、`/_next/*`。

> **已知边界（须显式记录）**：`src/app/collect/actions.ts` 是本仓库唯一的 `'use server'` 文件（Server Action），**不在 `/api/**` 下** → `/api/:path*` matcher 覆盖不到它，Server Action **不受认证保护**。Charter #3 只要求保护 `/api/**`，故按字面执行；此处记录为已知边界。后续若要保护，需要把 Server Action 迁到 `/api/**` 下或走别的机制。

**总开关**：`WR_AUTH_DISABLED=1` 显式关闭认证。

- **默认始终开启**（含 dev / test）——Charter #4。
- **proxy 与守卫读同一个 env**（#50 R6 风险：两处读法不一致会锁死用户）。
- 关闭时**不写审计**（`mode = 'disabled'`）。

**CI 断言（必须，#50 R2）**：新增测试，扫描 `src/app/api/**/route.ts`，断言：

1. 每个导出的 HTTP handler（GET/POST/PUT/DELETE/PATCH）都被 `withAuth` 包装。
2. `src/proxy.ts` 存在且 `config.matcher` 是常量 `'/' + 'api/:path*'`（防止有人改成变量或删掉）。
3. `src/proxy.ts` **不在仓库根目录**（防止被静默忽略的经典坑）。

漏改任何一处 → 测试失败。**这是 proxy 无法替代的保障**（见 §1.4 的职责边界）。

### 1.8 前端登录（Charter #2 #5）

**存储**：启动密码存 `localStorage`（key 建议 `weekly-reporter.auth`）。

**统一封装**：新增 `src/lib/api-client.ts`（客户端）：

```ts
// 读 localStorage 的密码，拼 Authorization 头；401 时抛统一的鉴权错误
export async function apiFetch(path: string, init?: RequestInit): Promise<Response>
```

**改造范围**：前端 **34 个文件 / 92 处 `fetch`**（`src/components/**`、`src/app/**`）需改用 `apiFetch`。

> **规模说明**：92 处 `fetch` 分布在 34 个文件里，`GenerationWorkspace.tsx` 一个文件就占 12 处（全是生成会话相关）。`apiFetch` 只负责**加头与 401 识别**，**不改变 body 的消费方式**——各调用点现有的 `response.json()` / `response.text()` / 流式读取逻辑保持原样，改造只是把 `fetch(url, init)` 换成 `apiFetch(url, init)`。

**登录门槛（Charter #5）**：

- 新增 `GET /api/auth/verify` → 无效则 401，有效则 200。
- 新增全页登录屏（如 `src/app/login/page.tsx`），输入启动密码 → 校验通过存 localStorage → 跳转回原页面。
- **拦截位置**：在根 layout（`src/app/layout.tsx`）挂一个客户端组件，检查 localStorage 是否有密码 + `GET /api/auth/verify` 是否通过；未通过则 `router.replace('/login')`。
- **API 401 的处理**：`apiFetch` 收到 401 → 清除 localStorage + 跳 `/login`。这覆盖「页面加载后密码被改 / PAT 被吊销」的情形。

> **页面 HTML 不设防**（Charter #3 / Round1 Q4），所以登录拦截是**客户端行为**，不是服务端重定向。这意味着未登录用户能拿到页面壳（静态 HTML），但拿不到任何数据。

### 1.9 安全页 UI（Charter #16）

**新增导航项**：`src/components/Navigation.tsx` 的 `NAV_ITEMS` 加 `{ href: '/security', label: 'Security', icon: Shield }`（lucide-react 已有 `Shield` 图标）。

**页面**：`src/app/security/page.tsx`，两个区块：

1. **PAT 管理**：列表（名称、创建时间、last_used_at、过期、状态）+ 创建表单（名称 + 可选过期）+ 吊销按钮。创建后**一次性展示明文**，带「只显示一次」提示与复制按钮。
2. **审计**：表格（时间、PAT 名称、method、path、status、agent、cwd、User-Agent），分页，最新在前。可按 PAT 名称 / status 过滤。

**数据来源**：全部走 §1.5 / §1.6 的 API（`/api/auth/pats`、`/api/audit`）。审计表**全量保留不清理**（Charter #12），故列表必须分页。

### 1.10 测试改造（Charter #4，Round2 Q9）

**现状**：84 个 vitest 测试文件 + 15 个 Playwright e2e 文件。

**vitest（`src/**/*.test.ts*`）**：

- **测试引导统一设 env**（Charter #4）：`src/test/setup.ts` 里加 `process.env.WR_AUTH_DISABLED = '1'`。
  - 这让**所有**现有测试**无需改动**即可通过（认证默认关闭）。
  - **但**：`src/test/setup.ts` 是 `setupFiles`，在每个测试文件前执行 → env 生效可靠。
  - ⚠️ `paths.ts` 用 `NODE_ENV === 'test'` 判定测试环境（重定向 XDG 目录到 tmpdir），**已验证** `CONFIG_DIR` 在测试下 = `os.tmpdir()/weekly-reporter-test-config` → 测试不会污染真实配置。
- **新增测试**（认证开启时的行为）：
  - `src/lib/auth/guard.test.ts`：双模式判定、密码 vs PAT、过期、吊销、`WR_AUTH_DISABLED` 分支、常量时间比较不泄漏。
  - `src/lib/auth/password.test.ts`：仅缺失时生成、跨调用稳定、48 位、文件权限、`ensureConfigDir`。
  - `src/lib/auth/pat.test.ts`：SHA-256 存储、明文只显示一次、吊销、过期判定。
  - `src/lib/auth/audit.test.ts`：只记 PAT、浏览器不记、失败记（`outcome='unauthorized'`）、`status` 取真实值、字段映射（method/path/status/UA/agent/cwd）。
  - `src/app/api/**/route.auth.test.ts`（或一条集中测试）：CI 断言 —— 每个 route 的导出 handler 都被 `withAuth` 包装；`src/proxy.ts` 位置与 matcher 正确。
- **既有 route 测试的兼容**：现有 route 测试（如 `src/app/api/events/route.test.ts`）直接调用导出的 `GET(request)`。改造后导出变成 `withAuth(...)` 的返回值，**签名仍是 `(req, ctx?)`**，且 `WR_AUTH_DISABLED=1` 时守卫直接放行 → **既有测试不需要改**。
  - ⚠️ 唯一需注意的：`withAuth` 包装后 handler 变成**匿名函数表达式**，`vi.mock` 的路径解析与 `this` 绑定不变；但**具名函数表达式**（`async function GET()`）保留了名字，便于测试断言调用。

**Playwright e2e**：

- `playwright.config.ts` 的 `webServer.env` 加 `WR_AUTH_DISABLED: '1'`（与 vitest 对齐，默认关闭）。
- **新增 e2e**：`e2e/auth.spec.ts` —— 启用认证场景（用另一个 webServer 实例或独立配置跑）：
  - 无凭证访问 `/api/events` → 401。
  - 错密码 → 401。
  - 正确密码 → 200。
  - PAT 调用 → 200，且审计表出现一行（`pat_name` 匹配、`status=200`）。
  - 吊销后用该 PAT → 401，且审计表出现 `status=401` 的行（D4）。
  - `WR_AUTH_DISABLED=1` → 全部放行。

> **e2e 的两套配置**：`playwright.config.ts` 默认关认证（现有 15 个 spec 不受影响）；认证专项用例通过**独立的 playwright project / 配置**（`e2e/auth.config.ts`）启用认证，避免污染现有用例。两者用不同的 `XDG_*_HOME` 隔离数据。

---

## 2. Skill 侧规格（Charter #8 #9 #14 #15）

### 2.1 改动清单（43 个 HTTP 入口）

| 类别 | 数量 | 路径 |
| --- | --- | --- |
| vendored `client.mjs` | **7** | `skills/{collect-git-source,collect-sources,period-plans,report-templates,timeline-tags,weekly-reports,write-weekly-report}/scripts/lib/client.mjs` |
| 经 client.mjs 的脚本 | **32** | 上述 7 个 skill 的 `scripts/*.mjs`（**全部实际发 HTTP**，部分经 `fetchAllSources` / `fetchAll` 间接调用） |
| timeline-events 内联脚本 | **4** | `skills/timeline-events/scripts/{post,query,update,delete}.mjs`（**无 client.mjs，自己拼 `WEEKLY_REPORTER_URL` + fetch**） |

> **总数 43**（7 + 32 + 4）。这是 Charter #15「仅本仓库 `skills/` 下 37 个脚本入口」的实际口径——**37 与 43 的差异**见 §5.1。

**不涉及**：`skills/*-workspace/**`（eval 用工作区与 `skill-snapshot` 副本）**不在改造范围**——它们是评测夹具，不是分发产物。但 `skills/timeline-events-workspace/skill-snapshot/scripts/*.mjs` 是 timeline-events 的快照，**可选同步**（建议同步，保持 snapshot 与实际一致；不强制）。

### 2.2 `client.mjs` 的改造（7 份）

**统一的凭据解析顺序**（Charter #8）：

```
1. env WEEKLY_REPORTER_PAT      → PAT
2. env WEEKLY_REPORTER_BASE_URL → baseUrl
   ↓ 两者都没有则
3. ~/.config/weekly-reporter/auth.json 的 machine.pat / machine.baseUrl
   ↓ 都没有则
4. 无 PAT（baseUrl 缺省为 http://localhost:6868）
```

> ⚠️ **现有 env 名是 `WEEKLY_REPORTER_URL`**（7 份 client.mjs 全部用它，SKILL.md 也这么写）。Charter #8 定的是 `WEEKLY_REPORTER_BASE_URL`。**决策：新增 `WEEKLY_REPORTER_BASE_URL`，同时保留 `WEEKLY_REPORTER_URL` 作为向后兼容的别名**（`WEEKLY_REPORTER_BASE_URL ?? WEEKLY_REPORTER_URL ?? ...`）。理由：eval 工作区的 `commands.md` 大量使用 `WEEKLY_REPORTER_URL`，直接改名会打断既有评测脚本。

**每个 client.mjs 新增**：

```js
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BASE_URL =
  process.env.WEEKLY_REPORTER_BASE_URL
  || process.env.WEEKLY_REPORTER_URL
  || readMachineConfig()?.baseUrl
  || 'http://localhost:6868'

export const PAT =
  process.env.WEEKLY_REPORTER_PAT
  || readMachineConfig()?.pat
  || null

export const AGENT_NAME = detectAgentName()
export const SKILL_NAME = '<写死的 skill 名>'
```

**`api(path, init)` 的改造**：在原 `fetch` 上加 `Authorization` 头（PAT 存在时）+ 自报头：

```js
const headers = {
  ...(init?.headers ?? {}),
  ...(PAT ? { Authorization: `Bearer ${PAT}` } : {}),
  'X-Weekly-Reporter-Agent': `${SKILL_NAME}/${AGENT_NAME}`,
  'X-Weekly-Reporter-Cwd': process.cwd(),
}
```

**401 处理**（Charter #9 要求的「401 错误指引跑 configure-pat」）：

```js
if (response.status === 401) {
  fail(
    `Error: Unauthorized (HTTP 401) from ${BASE_URL}`,
    'Your Personal Access Token is missing, invalid, expired, or revoked.',
    'Run the configure-pat skill (or: node scripts/configure-pat.mjs) to set one up.',
  )
}
```

**代理函数 `readMachineConfig()`**：读 `~/.config/weekly-reporter/auth.json`，**读不到或 JSON 损坏时返回 null，不抛错**（不能让凭据缺失把脚本搞崩）。注意 `CONFIG_DIR` 在脚本侧是**硬编码路径**（脚本不 import 服务端代码）：

```js
const CONFIG_PATH = join(homedir(), '.config', 'weekly-reporter', 'auth.json')
```

> ⚠️ **测试环境注意**：服务端 `paths.ts` 在 `NODE_ENV=test` 时重定向到 tmpdir，但**脚本侧不会**（脚本是独立 Node 进程，没有 `NODE_ENV=test`）。脚本一律读真实的 `~/.config/weekly-reporter/auth.json`。

**`detectAgentName()`**（7 份各自内联一份，因为 skill 要自包含）：

```js
function detectAgentName() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude-code'
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex'
  if (process.env.OPENCODE || process.env.OPENCODE_BIN) return 'opencode'
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  return 'unknown'
}
```

### 2.3 timeline-events 内联脚本（4 个）

这 4 个**没有** `client.mjs`，自己拼 URL 与 fetch。改造方式：

- 抽出同样的凭据解析 + 自报头逻辑（4 份各自内联，保持自包含——**或**新建 `skills/timeline-events/scripts/lib/client.mjs` 让它们共享）。
- **决策**：给 timeline-events **新建一份 `scripts/lib/client.mjs`**，让 4 个脚本改为 import 它。理由：与其它 7 个 skill 的结构一致，减少重复。（timeline-events 当前没有 `scripts/lib/` 目录，需新建。）

### 2.4 7 份 `client.mjs` 的重刷方案

7 份 client.mjs **内容有意不同**（各有该 skill 特有的 helper，如 `resolveSource` / `resolveRef` / `fetchAll` / `TAG_CHARSET_REGEX`），**不能简单覆盖**。

**重刷方案**：**新增一份共享模板** `skills/_shared/client-template.mjs`？——❌ 不行，skill 要**自包含可独立安装**（现有注释明确写了这点：「skills install individually, so this is vendored here (not imported from weekly-reports/scripts/lib/client.mjs)」）。

**实际可行的方案**：**脚本化重刷**。

1. 把**公共部分**（凭据解析、`api()`、错误处理、`detectAgentName`、自报头）抽成一段**标记块**：
   ```js
   // >>> AUTH-BLOCK:BEGIN (由 scripts/sync-client-auth.mjs 生成，勿手改)
   ...公共代码...
   // <<< AUTH-BLOCK:END
   ```
2. 写 `scripts/sync-client-auth.mjs`：读取模板里的标记块，替换 7 份 client.mjs 中对应的标记块。
3. CI 跑一次 `node scripts/sync-client-auth.mjs --check`：若任一份 client.mjs 与模板不一致 → 失败。

> **与 §1.7 的 CI 断言同源**：这是「多处拷贝必然漂移」的标准解法（参考仓库既有先例：`src/lib/db/migrations.ts` 的 `reconcileLegacyMigrations` 处理历史漂移）。

**首次落地**：7 份 client.mjs 里目前**没有**标记块 → 先手工插入（把公共部分整理成块），再上脚本。

### 2.5 `scripts/configure-pat.mjs` + `skills/configure-pat/`（Charter #9，D3）

**脚本** `scripts/configure-pat.mjs`（仓库根 `scripts/` 目录，与 `gen-build-info.mjs` 并列）：

```
用法:
  node scripts/configure-pat.mjs --base-url <url> [--name <name>]
  node scripts/configure-pat.mjs --pat <token> [--base-url <url>]
  node scripts/configure-pat.mjs --show          # 打印当前配置（PAT 打码）
  node scripts/configure-pat.mjs --clear         # 清除机器级凭据
```

**行为**：

- `--pat` + `--base-url` → 写入 `~/.config/weekly-reporter/auth.json` 的 `machine` 字段（保留同文件的 `password` 字段！）。
- `--base-url`（无 `--pat`）→ **交互式**：调用 `POST /api/auth/pats` 创建新 PAT（用启动密码认证），把返回的明文写入 `machine.pat`。
- **写文件必须保留 `password` 字段** —— 同一个文件承载启动密码与机器级凭据（§1.2）。读写时用「读 → 改 `machine` → 写回」的语义，**不能整体覆盖**。
- 文件权限 `chmod 600`。

**Skill** `skills/configure-pat/SKILL.md`（薄包装，D3：仓库内）：

- frontmatter：`name: configure-pat`，description 说明用途。
- 正文：何时用（脚本报 401、需要给 agent 配 PAT）、怎么跑（`node scripts/configure-pat.mjs`）、怎么人工用（安全页创建 PAT → 粘贴）。
- **不复制** client.mjs 逻辑（它自己也要调 API → 用 `scripts/configure-pat.mjs` 里的实现）。

> **人机两用**（Charter #9）：人可以直接开安全页创建 PAT；agent 跑脚本。两条路产出的 token 等价。

### 2.6 SKILL.md 的配套修改（10 个）

各 skill 的 SKILL.md 里有「读 `WEEKLY_REPORTER_URL` from env」的描述 + 错误排查表。需更新：

- 环境变量说明：加 `WEEKLY_REPORTER_PAT`、`WEEKLY_REPORTER_BASE_URL`、`WEEKLY_REPORTER_URL`（别名）。
- 错误排查表加一行：`Unauthorized (HTTP 401)` → `Token 缺失/失效/过期/被吊销 → 跑 configure-pat`。
- 记录「机器级凭据」的存在（`~/.config/weekly-reporter/auth.json`）。

---

## 3. 机器级凭据（Charter #8）

**文件**：`~/.config/weekly-reporter/auth.json` 的 `machine` 字段（**与启动密码同文件**，见 §1.2）。

```json
{
  "password": "<48 位启动密码>",
  "machine": {
    "baseUrl": "http://192.168.1.10:6868",
    "pat": "wrp_xxxxxxxx"
  }
}
```

**解析顺序**（env 覆盖文件，文件覆盖缺省）：

| 项 | 优先级（高→低） |
| --- | --- |
| baseUrl | `WEEKLY_REPORTER_BASE_URL` → `WEEKLY_REPORTER_URL` → `auth.json.machine.baseUrl` → `http://localhost:6868` |
| PAT | `WEEKLY_REPORTER_PAT` → `auth.json.machine.pat` → 无（不发 Authorization 头） |

**全部 skill 脚本走同一解析顺序**（Charter #8）。这由 §2.2 的共享标记块 + §2.4 的重刷脚本保证一致。

---

## 4. 文档产出

### 4.1 ADR-0020

**文件**：`docs/adr/0020-api-authentication-pat-and-audit.md`

**格式**：沿用本仓库既有 ADR 格式（`---\nstatus: accepted\n---\n# 标题\n\n正文\n\n## Considered Options\n...\n## Consequences\n...`）。参考 `docs/adr/0015-external-agent-peer-final-authoring.md`。

**要点**：

1. 引入认证：启动密码 + PAT 双模式，保护 `/api/**`。
2. 密码生成时机：`instrumentation.ts` 的 `register()`。
3. PAT 存 SHA-256 哈希，明文只显示一次，不做 scope。
4. 审计：只记 PAT 调用（含失败的尝试），存 DB 新表，全量保留。
5. **与 ADR-0015 的关系（D2）**：正文明确写 —— ADR-0015 当时**接受**了「外部 agent 撰写的终版无审计记录」这一缺口；本 ADR 引入的 PAT 审计**收窄**了该缺口：所有经 PAT 的 API 调用都有审计行。但 **ADR-0015 接受的部分仍然成立** —— 外部 agent 撰写的**终版内容本身**仍没有「谁写的、什么时候写的」这种 authorship 记录（审计记的是「调用了哪个 API」，不是「这段文字的作者」）。
   - **不修改 ADR-0015 原文**（D2）。
   - 这也正是 ADR-0015 的 Consequences 里预留的路径：「If audit parity for external authorship is ever required, add an explicit authorship record rather than reusing proposal linkage.」—— 本 ADR **不**新增 authorship 记录，只做 API 调用审计。
6. Considerd Options 要覆盖：只做 proxy（❌ 拿不到 status）/ 只做守卫（❌ 漏改风险）/ 双层（✅）；明文存 PAT（❌ 脚本凭据会跨机器传递）/ 哈希（✅）。

### 4.2 `CONTEXT.md` 术语更新

**位置**：新增 `## 认证与访问控制` 一节（放在 `## AI 集成` 之后，按现有章节的领域分组顺序）。**不新建 GLOSSARY.md**（本仓库无此文件，术语记在 CONTEXT.md —— map Notes 已确认）。

**新增 4 个术语**，格式严格遵循既有风格（`### 中文名 (English Name)` + 定义 + `_Avoid_: ...`）：

- `### 启动密码 (Startup Password)` —— 定义、存放位置、生成/重置规则。`_Avoid_: 管理员密码、root 密码`（本系统只有一个用户，没有多角色）。
- `### 个人访问令牌 (Personal Access Token)` —— 定义、存哈希、只显示一次、可吊销可过期、无 scope。`_Avoid_: API Key（与 AI 配置里的 api_key 混淆）、访问 token（未限定主体）`。
- `### 机器级凭据 (Machine Credential)` —— 定义、`auth.json` 的 `machine` 字段、env 覆盖顺序。`_Avoid_: 全局配置、环境配置`。
- `### 审计记录 (Audit Record)` —— 定义、只记 PAT 调用、字段含义（接口 vs 路径 vs Agent 的区分）。`_Avoid_: 日志（泛指服务端运行日志）、操作日志`（这两个词要按 Charter #11 的定义写清：「接口」= endpoint，「路径」= 调用方 cwd，「Agent」= 自报头）。

### 4.3 升级顺序文档（Charter #14）

**载体**：`docs/auth-upgrade.md`（新建）。Charter #14 要求写清顺序：**先配 PAT → 更新 skills → 重启服务端**。

**内容大纲**：

1. **为什么硬切换** —— 升级后所有 `/api/**` 都要求凭证；现有 skill 脚本不带 PAT → 全部 401。
2. **升级顺序**（关键：**服务端必须最后重启**）：
   - 步骤 1：在**旧版本**的服务端上无法创建 PAT（还没这功能）→ **先升级服务端**。
   - 步骤 2：重启服务端（认证生效）→ 打开安全页创建 PAT → 复制明文。
   - 步骤 3：跑 `configure-pat` 把 PAT 写进机器级凭据。
   - 步骤 4：更新 skills（git pull 后重刷 7 份 client.mjs + 4 个内联脚本）。
   - 步骤 5：验证 skill 脚本不再 401。
3. **兜底**：`WR_AUTH_DISABLED=1` 临时关闭认证（`systemctl --user edit weekly-reporter` 加 `Environment=WR_AUTH_DISABLED=1`，然后 `make restart`）。
4. **回滚**：删掉 `~/.config/weekly-reporter/auth.json` 的 `machine` 字段 + 恢复旧 skills。

> **顺序的一处实际修正**：Charter #14 写的「先配 PAT → 更新 skills → 重启服务端」在**首次引入认证**时不可行——旧服务端没有 PAT 功能，无法先配 PAT。首次升级的正确顺序是「**先重启服务端（认证生效）→ 创建 PAT → 配机器级凭据 → 更新 skills**」。本文档按实际可行顺序写，并说明「后续版本升级」才适用 Charter #14 的原顺序（那时 PAT 已存在）。

---

## 5. 与 Charter 的偏差清单（显式记录）

### 5.1 「37 个 skill 脚本入口」vs 实际 43

Charter #15 说「仅本仓库 `skills/` 下 37 个脚本入口（7 份 vendored `client.mjs` + timeline-events 4 个内联脚本）」。实际清点：

- 7 份 vendored `client.mjs`
- **32** 个经 client.mjs 的脚本（Charter 未提）
- 4 个 timeline-events 内联脚本

= **43**。Charter 的 37 = 7 + 4 + 26（少算了 6 个 importer）。**改造范围按实际 43 个**执行——`client.mjs` 改造后，32 个 importer **自动受益**（无需逐个改），但它们**必须全部实际发 HTTP**，逐个核对结果是 32 个**全部**发（部分经 `fetchAllSources` / `fetchAll` 间接调用）。

### 5.2 升级顺序的首次升级修正

见 §4.3 末尾。Charter #14 的顺序适用于「PAT 已存在后的后续升级」；首次引入认证需按文档中的实际顺序。

### 5.3 失败尝试也记审计（D4）

见 §0.2 与 §1.6。扩展了 Charter #10 的字面范围。

### 5.4 `WEEKLY_REPORTER_URL` 保留为别名

Charter #8 只提 `WEEKLY_REPORTER_BASE_URL`。实际保留 `WEEKLY_REPORTER_URL` 作为别名（理由见 §2.2）。

---

## 6. 实施顺序建议（给后续 dev session）

按依赖顺序，每步可独立验证：

1. **服务端核心**：`src/lib/auth/{password,pat,guard,audit,types}.ts` + `src/lib/db/schema.ts` 加表 + drizzle 迁移 + `instrumentation.ts` 加 `ensureStartupPassword()`。
2. **proxy**：`src/proxy.ts`（注意放 `src/` 下）+ build 验证 `ƒ Proxy (Middleware)` 出现。
3. **API route**：`/api/auth/verify`、`/api/auth/pats`、`/api/auth/pats/[id]`、`/api/audit`。
4. **53 个 route 套 `withAuth`**（脚本化改导出行）+ **CI 断言测试**（§1.7）。
5. **前端**：`src/lib/api-client.ts` + 34 个文件 / 92 处 `fetch` 改造 + 登录屏 + 根 layout 拦截 + 401 跳转。
6. **安全页**：`/security` + 导航项 + PAT 管理 + 审计表格。
7. **skill 侧**：7 份 client.mjs 标记块化 + `scripts/sync-client-auth.mjs` + timeline-events 新建 client.mjs + 4 个脚本改造。
8. **configure-pat**：`scripts/configure-pat.mjs` + `skills/configure-pat/SKILL.md`。
9. **文档**：ADR-0020 + CONTEXT.md 术语 + `docs/auth-upgrade.md` + 10 个 SKILL.md 更新。
10. **e2e**：`e2e/auth.spec.ts` + 独立 playwright 配置。

**验收线**：
- `npm run build` 输出含 `ƒ Proxy (Middleware)`。
- `npm run test` 全绿（含新加的 CI 断言测试）。
- `npm run test:e2e` 全绿（现有 15 个 spec + 新增 auth spec）。
- `node scripts/sync-client-auth.mjs --check` 通过。
- 人工验证：安全页创建 PAT → `configure-pat` 写入 → 任一 skill 脚本调用成功 → 安全页审计表出现对应行。

---

## 7. 引用

- 研究发现（一手来源完整引用）：`docs/research/2026-10-20-auth-middleware-and-audit.md`（分支 `research/auth-middleware-audit`，commit `b3e2570`）
- Charter decisions：map #49 的 Notes
- ADR：`docs/adr/0011-preserve-existing-token-on-source-edit.md`（密文前例，PAT 不沿用）、`docs/adr/0015-external-agent-peer-final-authoring.md`（审计缺口，ADR-0020 引用）
- 现有基础设施：`src/lib/paths.ts`（CONFIG_DIR）、`src/lib/db/index.ts`（getDb 单例 + 自动迁移）、`instrumentation.ts`（register 先例）、`src/lib/plan-references/db.ts`（`import 'server-only'` 先例）
