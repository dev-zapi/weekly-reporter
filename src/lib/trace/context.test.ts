import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_HEADER,
  isValidSpanId,
  isValidTraceId,
} from './ids'
import {
  applyTraceResponseHeaders,
  getTraceContext,
  outboundTraceHeaders,
  runWithTrace,
  traceLogPrefix,
  type TraceContext,
} from './context'
import { installTraceConsolePatch } from './console-patch'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PREFIX_PATTERN = /^\[traceId=[0-9a-f]{32} spanId=[0-9a-f]{16}\]$/

/** 在回调里抓当前上下文（runWithTrace 的返回值只用于断言，上下文需要另取）。 */
async function captureContext(): Promise<TraceContext> {
  const context = getTraceContext()
  if (!context) throw new Error('expected a trace context')
  return { ...context }
}

describe('without a trace context', () => {
  it('reports no context and empty derived values', () => {
    expect(getTraceContext()).toBeUndefined()
    expect(traceLogPrefix()).toBe('')
    expect(outboundTraceHeaders()).toEqual({})
  })

  it('leaves response headers untouched', () => {
    const res = new Response('ok')
    applyTraceResponseHeaders(res)

    expect(res.headers.get(TRACE_ID_HEADER)).toBeNull()
    expect(res.headers.get(SPAN_ID_HEADER)).toBeNull()
    expect(res.headers.get(TRACE_PARENT_HEADER)).toBeNull()
  })
})

describe('runWithTrace', () => {
  it('creates a root context with fresh valid ids', async () => {
    const context = await runWithTrace(captureContext)

    expect(isValidTraceId(context.traceId)).toBe(true)
    expect(isValidSpanId(context.spanId)).toBe(true)
  })

  it('reuses the trace id supplied by the caller', async () => {
    const context = await runWithTrace(captureContext, { traceId: TRACE_ID })

    expect(context.traceId).toBe(TRACE_ID)
    expect(isValidSpanId(context.spanId)).toBe(true)
  })

  it('passes through a nested runWithTrace instead of creating a new root', async () => {
    const outer = await runWithTrace(async () => {
      const before = await captureContext()
      const inner = await runWithTrace(captureContext)
      return { before, inner }
    })

    expect(outer.inner.traceId).toBe(outer.before.traceId)
    expect(outer.inner.spanId).toBe(outer.before.spanId)
  })

  it('keeps the context across await and macrotask boundaries', async () => {
    const context = await runWithTrace(async () => {
      const before = await captureContext()
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const after = await captureContext()
      return { before, after }
    })

    expect(context.after).toEqual(context.before)
  })

  it('restores the previous context after the callback resolves', async () => {
    await runWithTrace(async () => {
      expect(getTraceContext()).toBeDefined()
    })

    expect(getTraceContext()).toBeUndefined()
  })
})

describe('response headers and outbound propagation', () => {
  it('prefixes log lines with the current trace and span ids', async () => {
    await runWithTrace(async () => {
      const context = await captureContext()
      expect(traceLogPrefix()).toBe(`[traceId=${context.traceId} spanId=${context.spanId}]`)
    })
  })

  it('applies trace headers to a response inside the context', async () => {
    const res = new Response('ok')

    await runWithTrace(
      async () => {
        const context = await captureContext()
        applyTraceResponseHeaders(res)
        return context
      },
      { traceId: TRACE_ID },
    )

    expect(res.headers.get(TRACE_ID_HEADER)).toBe(TRACE_ID)
    expect(res.headers.get(SPAN_ID_HEADER)).toMatch(/^[0-9a-f]{16}$/)
    expect(res.headers.get(TRACE_PARENT_HEADER)).toMatch(
      new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`),
    )
  })

  it('never throws when the response headers are immutable', async () => {
    const immutable = Response.error()

    await runWithTrace(async () => {
      expect(() => applyTraceResponseHeaders(immutable)).not.toThrow()
    })
  })

  it('builds outbound headers from the current span', async () => {
    const outbound = await runWithTrace(async () => {
      const context = await captureContext()
      return { context, headers: outboundTraceHeaders() }
    })

    expect(outbound.headers).toEqual({
      [TRACE_PARENT_HEADER]: `00-${outbound.context.traceId}-${outbound.context.spanId}-01`,
      [TRACE_ID_HEADER]: outbound.context.traceId,
    })
  })
})

describe('installTraceConsolePatch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is idempotent and prefixes console output only inside a trace', async () => {
    // 先 spy 再装补丁：补丁包装的是 spy，于是能观察到「前缀被插到最前面」。
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    installTraceConsolePatch()
    installTraceConsolePatch() // 幂等：重复安装不会叠出第二层前缀

    await runWithTrace(async () => {
      console.log('inside')
    })
    console.log('outside')

    const insideCalls = log.mock.calls.filter((call) => call.includes('inside'))
    const outsideCalls = log.mock.calls.filter((call) => call.includes('outside'))

    expect(insideCalls).toHaveLength(1)
    expect(insideCalls[0]).toHaveLength(2)
    expect(insideCalls[0][0]).toMatch(PREFIX_PATTERN)
    expect(insideCalls[0][1]).toBe('inside')

    expect(outsideCalls).toEqual([['outside']])
    expect(getTraceContext()).toBeUndefined()
  })
})
