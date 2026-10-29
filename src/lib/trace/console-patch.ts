import 'server-only'
import { getTraceContext, traceLogPrefix } from './context'

/**
 * 给 console 打 trace 前缀补丁（Sleuth 的招牌能力）。
 *
 * 只在 instrumentation.ts 的 nodejs 分支调用一次；包装后凡是处在 trace 上下文里的
 * 日志都会自动在最前面带上 `[traceId=xxx spanId=xxx]`，既有 console 调用点一行
 * 都不用改。无上下文时原样透传。
 *
 * 幂等：用 `Symbol.for` 挂在 globalThis 上，避免 instrumentation 被重复执行
 * （或模块被重复实例化）时叠出多层前缀。
 */
const INSTALL_FLAG = Symbol.for('weekly-reporter.trace-console-patch')

const PATCHED_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

export function installTraceConsolePatch(): void {
  const globalStore = globalThis as unknown as Record<symbol, unknown>
  if (globalStore[INSTALL_FLAG]) return
  globalStore[INSTALL_FLAG] = true

  for (const method of PATCHED_METHODS) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      // 无上下文时 traceLogPrefix() 为空串，直接透传，保持日志原貌。
      if (getTraceContext()) {
        original(traceLogPrefix(), ...args)
      } else {
        original(...args)
      }
    }
  }
}
