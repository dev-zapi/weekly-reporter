import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_HEADER,
  isValidSpanId,
  isValidTraceId,
} from '@/lib/trace/ids'
import { getTraceContext } from '@/lib/trace/context'

vi.mock('@/lib/db', () => {
  const getDb = vi.fn()
  return { getDb }
})

vi.mock('@/lib/auth/password', () => ({
  readStartupPassword: vi.fn(() => null),
}))

import { getDb } from '@/lib/db'
import { readStartupPassword } from './password'
import { withAuth } from './guard'

const mockedGetDb = getDb as unknown as ReturnType<typeof vi.fn>
const mockedReadPassword = readStartupPassword as unknown as ReturnType<typeof vi.fn>

/** setup.ts 默认把认证关掉；本文件要测开启后的行为，故先摘掉，测完还原 */
const originalAuthDisabled = process.env.WR_AUTH_DISABLED

const INCOMING_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const INCOMING_SPAN_ID = '00f067aa0ba902b7'
const TRACE_PARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/

function request(headers?: Record<string, string>): Request {
  return new Request('http://localhost:6868/api/events', { method: 'GET', headers })
}

function assertTraceHeaders(response: Response) {
  const traceId = response.headers.get(TRACE_ID_HEADER)
  const spanId = response.headers.get(SPAN_ID_HEADER)
  const traceParent = response.headers.get(TRACE_PARENT_HEADER)

  expect(traceId).toMatch(/^[0-9a-f]{32}$/)
  expect(isValidTraceId(traceId!)).toBe(true)
  expect(spanId).toMatch(/^[0-9a-f]{16}$/)
  expect(isValidSpanId(spanId!)).toBe(true)
  expect(traceParent).toMatch(TRACE_PARENT_PATTERN)

  const match = TRACE_PARENT_PATTERN.exec(traceParent!)!
  expect(match[1]).toBe(traceId)
  expect(match[2]).toBe(spanId)
}

describe('withAuth trace integration', () => {
  beforeEach(() => {
    mockedGetDb.mockReset()
    mockedReadPassword.mockReturnValue(null)
    delete process.env.WR_AUTH_DISABLED
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (originalAuthDisabled === undefined) {
      delete process.env.WR_AUTH_DISABLED
    } else {
      process.env.WR_AUTH_DISABLED = originalAuthDisabled
    }
  })

  it('adds trace headers to a successful handler response', async () => {
    process.env.WR_AUTH_DISABLED = '1'
    const wrapped = withAuth(async (_req: Request) => new Response('ok', { status: 200 }))

    const response = await wrapped(request())

    expect(response.status).toBe(200)
    assertTraceHeaders(response)
  })

  it('inherits the trace id from an inbound traceparent header', async () => {
    process.env.WR_AUTH_DISABLED = '1'
    let seen: string | undefined
    const wrapped = withAuth(async (_req: Request) => {
      seen = getTraceContext()?.traceId
      return new Response('ok')
    })

    const response = await wrapped(
      request({ traceparent: `00-${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-01` }),
    )

    expect(seen).toBe(INCOMING_TRACE_ID)
    expect(response.headers.get(TRACE_ID_HEADER)).toBe(INCOMING_TRACE_ID)
    assertTraceHeaders(response)
  })

  it('makes the trace context available inside the handler', async () => {
    process.env.WR_AUTH_DISABLED = '1'
    let context: ReturnType<typeof getTraceContext>
    const wrapped = withAuth(async (_req: Request) => {
      context = getTraceContext()
      return new Response('ok')
    })

    await wrapped(request())

    expect(context).toBeDefined()
    expect(isValidTraceId(context!.traceId)).toBe(true)
    expect(isValidSpanId(context!.spanId)).toBe(true)
  })

  it('adds trace headers to the 401 response when authentication fails', async () => {
    const handler = vi.fn<(req: Request, ctx?: unknown) => Promise<Response>>(
      async () => new Response('should not run'),
    )
    const wrapped = withAuth(handler)

    const response = await wrapped(request())

    expect(response.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    assertTraceHeaders(response)
  })

  it('rethrows handler errors after logging them with the trace context', async () => {
    process.env.WR_AUTH_DISABLED = '1'
    const boom = new Error('boom')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapped = withAuth(async (_req: Request) => {
      throw boom
    })

    await expect(wrapped(request())).rejects.toBe(boom)

    expect(errorSpy).toHaveBeenCalledWith('Unhandled route handler error:', boom)
    expect(getTraceContext()).toBeUndefined()
    errorSpy.mockRestore()
  })
})
