import path from 'node:path'

/**
 * B8 预切换演练的 Go 单二进制 server（蓝图 §7）。
 *
 * 与 next-server.ts 平行存在的件：`E2E_SERVER_IMPL=go` 时由两个 playwright
 * config 选用，spec 零改动；cutover 后转正为默认（next-server.ts 删除）。
 *
 * 命令只做三件事，不引额外状态：
 *   make build && PORT=<port> HOSTNAME=127.0.0.1 bin/wr db migrate
 *              && PORT=<port> HOSTNAME=127.0.0.1 bin/wr serve
 * - `make build`：vite -> embed -> go build，出发布工件 bin/wr（同一条链）。
 * - `db migrate`：serve 对空库 fail closed（迁移账本校验，显式迁移只在
 *   `wr db migrate`），必须先迁移。XDG 根由 config 的 webServer.env 注入
 *   （默认套件随机 tmp 根，auth 套件固定 auth 目录），本命令继承同一份
 *   env，两次 wr 调用落在同一个库上。
 * - PORT/HOSTNAME 是 wr serve 的监听配置（蓝图 §2.6：与 TS 侧同名同值）。
 *
 * 演练实测（2026-11-07，8G MemoryMax / 300% CPUQuota，与 next-server.ts 的
 * 决策记录同法）：默认套件 25/25 ×两轮，peak 6520–6615 MiB（1.4m）；auth
 * 套件 4/4，peak 960 MiB；make build 单独 0.86G。同日同机 Next 对照
 * 6467 MiB / 1.7m——不劣于即达标（蓝图 §7.4），oom_kill=0。默认套件峰值
 * 主体在测试侧（Chromium + 流式会话），与服务器实现无关。
 */

/** 蓝图 §7 定的预算：build（web+go）+ 迁移 + 起服在 2min 内。 */
export function goWebServerTimeout(): number {
  return 2 * 60 * 1000
}

export function goWebServerCommand(port: number): string {
  const wr = path.resolve('bin/wr')
  const env = `PORT=${port} HOSTNAME=127.0.0.1 `
  return `make build && ${env}${wr} db migrate && ${env}${wr} serve`
}
