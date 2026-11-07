import path from 'node:path'

/**
 * e2e 的常驻 server：Go 单二进制（bin/wr）。cutover 后唯一实现——
 * next-server.ts 已删除（蓝图 §7 cutover：e2e 永久指向 Go）。
 *
 * 命令只做三件事，不引额外状态：
 *   make -C <repoRoot> build && PORT=<port> HOSTNAME=127.0.0.1 bin/wr db migrate
 *                       && PORT=<port> HOSTNAME=127.0.0.1 bin/wr serve
 * - `make -C <repoRoot> build`：vite -> embed -> go build，出发布工件 bin/wr
 *   （同一条链）。绝对路径 + -C 使命令与 webServer 的 cwd 无关（auth.config
 *   位于 e2e/ 子目录，configDir 是其默认 cwd）。
 * - `db migrate`：serve 对空库 fail closed（迁移账本校验，显式迁移只在
 *   `wr db migrate`），必须先迁移。XDG 根由各 config 的 webServer.env 注入
 *   （默认套件随机 tmp 根，auth 套件固定 auth 目录），本命令继承同一份
 *   env，两次 wr 调用落在同一个库上。
 * - PORT/HOSTNAME 是 wr serve 的监听配置（蓝图 §2.6：与 TS 侧同名同值）。
 *
 * 实测决策记录（2026-11-07，8G MemoryMax / 300% CPUQuota）：默认套件
 * 25/25 ×两轮，peak 6520–6615 MiB（1.4m）；auth 套件 4/4，peak 960 MiB；
 * make build 单独 0.86G。cutover 当日同机 Next 对照 6467 MiB / 1.7m——
 * 不劣于即达标（蓝图 §7.4），oom_kill=0。默认套件峰值主体在测试侧
 * （Chromium + 流式会话），与服务器实现无关。
 */

/** make build（web+go）+ 迁移在 2min 预算内（蓝图 §7 定的预算）。 */
export function goWebServerTimeout(): number {
  return 2 * 60 * 1000
}

export function goWebServerCommand(port: number): string {
  const root = path.resolve(__dirname, '..')
  const wr = path.join(root, 'bin', 'wr')
  const env = `PORT=${port} HOSTNAME=127.0.0.1 `
  return `make -C ${root} build && ${env}${wr} db migrate && ${env}${wr} serve`
}

/** Worker fixture（app-fixture / legacy-migration）也直接用这个二进制。 */
export const wrBin = path.resolve(__dirname, '..', 'bin', 'wr')
