import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_HEADER,
  newSpanId,
  newTraceId,
  traceParentString,
} from './ids'

/**
 * 请求级 trace 上下文（Sleuth 简化版）。
 *
 * 每个 API 请求 = 一个根 span：`withAuth` 在入口处 `runWithTrace` 建根，
 * handler 内部所有 await 链路通过 AsyncLocalStorage 共享上下文；需要细粒度计时
 * 的段落用 `withSpan` 开子 span。
 */
export interface TraceContext {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
}

/**
 * ALS 实例必须挂在 globalThis 上：dev 模式（Turbopack）下 instrumentation 与各
 * route 分属不同模块图，模块顶层的 `new AsyncLocalStorage()` 会被实例化多份——
 * withAuth 写的是路由侧实例，console 补丁读的是 instrumentation 侧实例，前缀
 * 永远读不到。用 `Symbol.for` 单例保证两侧共享同一个存储（与 console 补丁的
 * 幂等标记同一手法）。
 */
const STORAGE_KEY = Symbol.for('weekly-reporter.trace-als')

function getStorage(): AsyncLocalStorage<TraceContext> {
  const globalStore = globalThis as unknown as Record<symbol, unknown>
  let storage = globalStore[STORAGE_KEY] as AsyncLocalStorage<TraceContext> | undefined
  if (!storage) {
    storage = new AsyncLocalStorage<TraceContext>()
    globalStore[STORAGE_KEY] = storage
  }
  return storage
}

/** 当前异步链路的 trace 上下文；未处在任何 trace 中时返回 undefined。 */
export function getTraceContext(): TraceContext | undefined {
  return getStorage().getStore()
}

/**
 * 在 trace 上下文中执行 `fn`。
 *
 * 已有上下文时直接透传执行（不新建根）：嵌套调用（例如 withAuth 包住的东西再次
 * 调 runWithTrace）不会把 traceId/根 spanId 换掉。没有上下文时以
 * `options.traceId`（缺省 `newTraceId()`）建根，name 固定为 `request`。
 */
export async function runWithTrace<T>(
  fn: () => Promise<T> | T,
  options?: { traceId?: string },
): Promise<T> {
  if (getStorage().getStore()) {
    return await fn()
  }

  const context: TraceContext = {
    traceId: options?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: null,
    name: 'request',
  }

  return getStorage().run(context, async () => fn())
}

/**
 * 开一个子 span 执行 `fn`：新 spanId，parentSpanId 指向当前 span，traceId 不变。
 *
 * 结束后无论成败都打一行完成日志（ok 标记结果），失败时先打日志再原样 rethrow。
 * 没有任何上下文时也允许调用：此时按「新建根、无父 span」处理，便于独立使用。
 */
export async function withSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const parent = getStorage().getStore()
  const context: TraceContext = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.spanId ?? null,
    name,
  }
  const startedAt = Date.now()

  return getStorage().run(context, async () => {
    let ok = true
    try {
      return await fn()
    } catch (error) {
      ok = false
      throw error
    } finally {
      console.log(
        `[trace] span complete name=${name} traceId=${context.traceId} spanId=${context.spanId} parentSpanId=${context.parentSpanId ?? 'null'} durationMs=${Date.now() - startedAt} ok=${ok}`,
      )
    }
  })
}

/** 日志前缀：`[traceId=xxx spanId=xxx]`；无上下文返回空串。 */
export function traceLogPrefix(): string {
  const context = getStorage().getStore()
  if (!context) return ''
  return `[traceId=${context.traceId} spanId=${context.spanId}]`
}

/**
 * 给响应补上统一的 trace 响应头（x-trace-id / x-span-id / traceparent）。
 *
 * 某些 Response（例如已发出的流式响应）headers 不可变，`set` 会抛错；trace 头是
 * 诊断辅助，失败静默跳过，绝不能让它把正常响应变成 500。
 */
export function applyTraceResponseHeaders(res: Response): void {
  const context = getStorage().getStore()
  if (!context) return

  try {
    res.headers.set(TRACE_ID_HEADER, context.traceId)
    res.headers.set(SPAN_ID_HEADER, context.spanId)
    res.headers.set(TRACE_PARENT_HEADER, traceParentString(context.traceId, context.spanId))
  } catch {
    // 响应头不可变：静默跳过
  }
}

/**
 * 出站 HTTP 调用要带的 trace 头。
 *
 * W3C 语义下 traceparent 的 span 位表示「调用方的当前 span」，即下游的 parent，
 * 所以这里放当前 spanId（而不是新开一个）。无上下文返回空对象，调用方可安全展开。
 */
export function outboundTraceHeaders(): Record<string, string> {
  const context = getStorage().getStore()
  if (!context) return {}

  return {
    [TRACE_PARENT_HEADER]: traceParentString(context.traceId, context.spanId),
    [TRACE_ID_HEADER]: context.traceId,
  }
}
