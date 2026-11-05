---
status: accepted
---

# 前端 SPA 化：Vite + React Router v7，Next 依赖直接真替换

前端从 Next.js App Router 迁出为 Vite + React Router **v7**（库模式）SPA，由 Go 单二进制 embed 服务（ADR-0025）。`web/` 作为 pnpm workspace 包（`packages: ['.', 'web']`，共享 lockfile；仓根 workspace 缺 `packages:` 字段会把 `web/` 安装静默吸到根——实证坑）。Next 客户端 API 依赖**直接真替换**、不留 next-compat shim 常驻层：`next/link` → RR `Link`（×15 文件）、`useRouter`/`usePathname`/`useSearchParams`/`useParams` → RR hooks（×15 处）、`next/dynamic` → `React.lazy`+`Suspense`（仓内唯一用例 Milkdown 编辑器）、`next/font` → `@fontsource-variable/geist` 双包自托管并在 `:root` 挂同名 `--font-geist-*` 变量（globals.css 与设计系统零改动）。两条路线成本都已被壳切片量化（shim ≈200 行 vs 每处约 5 分钟机械活），取直接替换：终态零 next 依赖。

SPA 特有语义：`authEnabled` 不能先渲染后探测（初始按 true 会让 AuthGate 抢跑重定向），bootstrap 阶段无头 `GET /api/auth/verify`——**200 = 认证关闭（WR_AUTH_DISABLED=1）、401 = 开启**——再挂载应用，零新增 API。build-info 构建期脚本模式照搬（写 `web/src/build-info.ts`，alias `@/lib/build-info` 接管）。构建配置实证坑：Tailwind v4 需显式 `@source` 回指仓根 `src`（否则类名静默丢失）；`resolve.dedupe: ['react','react-dom']` 必加（防预打包带入第二份 React）；CSS 内相对 `@import` 从 CSS 文件自身起算路径。SPA 迁移**整体排在后端 B0–B6 全部完成之后**（串行，ADR-0030）；code-split 与懒加载为优化项非阻塞。

## Considered Options

- **next-compat shim 常驻** vs **直接改 import**：shim 少改文件但永久背一层间接；直接替换后代码即终态。
- **React Router v8**（已出 8.5.1）vs **钉 v7**（7.18.5 维护中）：钉 v7，v8 演进列风险登记盯梢。
- **Next 静态导出保留 Next 构建**：保留 next 构建链与双 dev-server 锁，违背单二进制动机。

## Consequences

- `src/` 客户端代码的 `next/*` import 全部消失；`src/app` 服务端层（路由、server action、layout 服务端渲染）在 cutover PR 退役。
- 15 页路由表与每页对应关系进 `docs/migration-blueprint.md` 施工批次节。
- dev 期挂载前多一次 verify 往返（仅首载）。
- `vite dev` 的 `/api` proxy 过渡期无意义（SPA 批在后端完成后开工，proxy 直指 Go）。
