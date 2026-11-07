# B7 整批验收清单（可执行版）

> 依据 [migration-blueprint.md](migration-blueprint.md) §5 B7 三条关批条件 + ADR-0028/0029 拆成的可执行步骤。
> 本文件只把已冻结结论落成命令，不含新的设计决定；在**集成分支**（三张 B7 票合入后）执行，不在单票分支执行。

## 前置

```bash
# workspace 落地后（#113）：web/ 进 pnpm workspace，共享 lockfile
pnpm install
# SPA 构建/开发前生成 build-info（#115 的脚本，由 #113 的 web/package.json 脚本调用）
node web/scripts/gen-build-info.mjs
```

## 验收 1：web/ 脱 Next 独立构建全绿

```bash
pnpm -C web build          # node scripts/gen-build-info.mjs && vite build
# 通过判定：退出码 0，且 web/dist/index.html + web/dist/assets/* 生成
```

红线自查（构建产物层面）：

- [ ] `react-router` 为 ^7.18.5（`web/package.json` + lockfile 双重核对），未升 v8
- [ ] `react` / `react-dom` 版本与 prototype/vite-spa-shell 一致（19.2.4）
- [ ] `web/vite.config.ts` 含 `resolve.dedupe: ['react', 'react-dom']`
- [ ] Tailwind v4 入口含显式 `@source` 回指仓根 `src`（`web/src/styles/tailwind.css`）
- [ ] `web/src` 无 `next-compat/` 目录（不留 shim）、无 `next` 依赖
- [ ] `web/package.json` 的 `dev` / `build` 脚本前调用 `node scripts/gen-build-info.mjs`（与根 `scripts/gen-build-info.mjs` 同模式）
- [ ] `web/vite.config.ts` 的 `resolve.alias` 在通用 `@` 别名**之前**含 `@/lib/build-info → web/src/build-info.ts` 的精确匹配（ADR-0028，双轨之一）

## 验收 2：对 Go API 全功能跑通（15 页全量）

```bash
XDG_DATA_HOME=$PWD/tmp/data XDG_CONFIG_HOME=$PWD/tmp/config \
  go run ./cmd/wr db migrate
XDG_DATA_HOME=$PWD/tmp/data XDG_CONFIG_HOME=$PWD/tmp/config \
  PORT=16873 WR_AUTH_DISABLED=1 E2E_FIXTURES=1 go run ./cmd/wr serve
XDG_DATA_HOME=... pnpm -C web dev --port 15173 --strictPort   # proxy /api → 127.0.0.1:16873
```

逐页清单（路由与 `src/app` 1:1）：`/login`、`/`（timeline）、`/new`、`/edit/[id]`、`/plans`、`/collect`、`/collect/new`、`/collect/[id]`、`/reports`、`/reports/[id]`、`/templates`、`/templates/new`、`/templates/[id]`、`/prompts`、`/security`、`/audit`。

- [ ] 每页首屏无 console error、无 4xx/5xx 的 `/api/*`（auth 中间件 401 除外）
- [ ] 生成会话在线回合：真实模型调用**按 2026-11-07 用户豁免跳过**，验证到「发起前」的功能面即可
- [ ] auth 开启态（不带 `WR_AUTH_DISABLED`，预置 auth.json）：无头 `GET /api/auth/verify` 必须 401，带 Bearer 200
- [ ] 页面外壳（AppShell / AuthGate / Toaster）在 Go API 下正常，`/api/auth/verify` 探测先于挂载（ADR-0028）

## 验收 3：`src/` 零 `next/*` import（SPA 侧）

```bash
npm run check:web     # node scripts/check-web-no-next-imports.mjs
# 通过判定：退出码 0，输出 "check-web-no-next-imports: OK (N files, zero next/* imports)"
```

守护对象是 **`web/src`**（SPA 侧）。Next 应用 `src/` 在 B8 cutover 前原样保留，本检查**不**扫它——扫描范围写死在脚本里，别放宽。
匹配四类写法：`from 'next/...'`、`import('next/...')`、`require('next/...')`、`import 'next/...'`。

## 附：全量 e2e 不回退

```bash
npm run test:e2e     # 仍指向 Next 生产构建（go-server.ts 转正属 B8）
```

- [ ] 默认套件 + auth 套件全绿，spec 零改动（ADR-0029）
