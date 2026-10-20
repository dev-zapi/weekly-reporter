# 认证升级指南

> 引入 API 认证（启动密码 + PAT）后，现有 skill 脚本不再带凭证，全部 `/api/**` 调用会返回 401。本文档给出升级顺序与兜底手段。
> 完整设计见 [实现规格](auth-implementation-spec.md) 与 [ADR-0020](adr/0020-api-authentication-pat-and-audit.md)。

## 这次变更是硬切换

升级后，**每一个** `/api/**` 请求都必须带 `Authorization` 头。页面 HTML 和静态资源不受影响，但所有脚本（43 个 skill HTTP 入口）会立刻开始 401。

好消息：一次性配好之后，日常不需要再管。凭据存在机器上，脚本自己读。

## 首次升级的顺序

> ⚠️ 原始设想是「先配 PAT → 更新 skills → 重启服务端」，但**首次引入认证时不可行**——旧版本服务端没有 PAT 功能，配不出来。首次升级按下面的实际顺序；此后 PAT 已存在，后续版本升级才适用「先配 PAT → 更新 skills → 重启服务端」。

### 步骤 1 — 更新代码并重启服务端

```bash
cd ~/github/weekly-reporter
git pull
npm install
npm run build
make restart
```

重启后，服务端会在**首次启动时**生成启动密码（若 `~/.config/weekly-reporter/auth.json` 里没有 `password` 字段）。**认证从此刻起生效**，此后的 API 调用都需要凭证。

### 步骤 2 — 取回启动密码

```bash
cat ~/.config/weekly-reporter/auth.json
```

里面形如：

```json
{
  "password": "aB3xY9…（48 位）",
  "machine": { "baseUrl": "…", "pat": "…" }
}
```

- **这个文件同时装着启动密码和机器级凭据**——不要整体覆盖它。
- 文件权限应为 `600`。若不对：`chmod 600 ~/.config/weekly-reporter/auth.json`
- 忘记了？删掉这个文件再 `make restart`，会重新生成一个新密码。

### 步骤 3 — 创建 PAT

浏览器打开 `http://<你的服务器地址>:6868/security`（新导航页「Security」），在 **PAT 管理** 区块创建一个令牌。

- **明文只显示一次**，页面关闭后取不回来。立即复制。
- 可选设置过期时间（默认永久）。
- 名字写清楚用途，例如 `claude-code-laptop`。

### 步骤 4 — 写入机器级凭据

```bash
node scripts/configure-pat.mjs --pat wrp_xxxxxxxx --base-url http://localhost:6868
```

脚本会**只改 `machine` 字段**，保留同文件的 `password`。

想省掉手工复制，也可以让脚本自己创建：

```bash
node scripts/configure-pat.mjs --base-url http://localhost:6868
```

（会交互式提示输入启动密码，然后调 `POST /api/auth/pats` 建一个新 PAT 并写进 `machine`。）

### 步骤 5 — 更新 skills

skills 随仓库分发，`git pull` 之后就是新的。但**如果你把 skill 复制到了别的目录**（仓库外的 agent 目录），那些副本需要单独更新。

验证：

```bash
node skills/timeline-events/scripts/query.mjs --limit 1
```

不再 401 即成功。

### 步骤 6 — 确认审计在工作

打开 `/security` 的**审计**区块，应该能看到刚才那次调用的一行（PAT 名称、method、path、status=200、Agent 标识）。

---

## 兜底：临时关掉认证

出问题（脚本全 401、密码丢了、PAT 配错了）时：

```bash
systemctl --user edit weekly-reporter
```

在 `[Service]` 段加：

```
Environment=WR_AUTH_DISABLED=1
```

然后：

```bash
make restart
```

认证完全关闭（proxy 与守卫读同一个 env）。**这是临时手段**——认证关闭期间所有 `/api/**` 敞开着。恢复时删掉那行再 `make restart`。

---

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 脚本报 `Unauthorized (HTTP 401)` | PAT 缺失 / 失效 / 过期 / 被吊销 | 跑 `node scripts/configure-pat.mjs` 重新配；或看安全页审计里那条 401 行确认原因 |
| 脚本报 `Cannot reach weekly-reporter` | 服务端没起或地址不对 | `make status`；检查 `machine.baseUrl` 是否指向正确地址 |
| 页面能开但数据全是空的 | 前端没登录，localStorage 里没有密码 | 访问 `/login` 输入启动密码 |
| 页面一直跳回登录页 | 密码被改过 / localStorage 里是旧密码 | 重新登录 |
| PAT 脚本调用成功但审计页没有记录 | 用的不是 PAT（是启动密码），或审计被关了 | 确认脚本走的是 `machine.pat` 而不是密码 |

---

## 回滚

1. `WR_AUTH_DISABLED=1` + `make restart`（立刻恢复可用）
2. 删除 `~/.config/weekly-reporter/auth.json` 里的 `machine` 字段（启动密码可保留）
3. `git checkout` 回退到引入认证之前的 commit，并 `npm run build && make restart`

---

## 日常维护

- **新增 skill 脚本**：新脚本必须走 `scripts/lib/client.mjs` 的 `api()`（或自己实现同一套凭据解析），否则不会带 `Authorization` 头。7 份 vendored 拷贝由 `node scripts/sync-client-auth.mjs --check` 保证同步。
- **轮换 PAT**：安全页创建新的 → 更新机器级凭据 → 吊销旧的。顺序反了会短暂断掉。
- **机器换了**：在新机器上跑 `configure-pat` 即可，不需要重新创建 PAT（PAT 存在服务端数据库里）。
