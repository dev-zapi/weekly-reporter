import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import {
  SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_HEADER,
  isValidSpanId,
  isValidTraceId,
} from '@/lib/trace/ids'
import { proxy } from './proxy'

const originalAuthDisabled = process.env.WR_AUTH_DISABLED

const INCOMING_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const INCOMING_SPAN_ID = '00f067aa0ba902b7'
const TRACE_PARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/

function makeRequest(headers?: Record<string, string>): NextRequest {
  return new Request('http://localhost:6868/api/events', {
    method: 'GET',
    headers,
  }) as unknown as NextRequest
}

/** NextResponse.next() 会打上 x-middleware-next: 1，用它判定「放行」。 */
function isPassThrough(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1'
}

describe('proxy trace integration', () => {
  beforeEach(() => {
    delete process.env.WR_AUTH_DISABLED
  })

  afterEach(() => {
    if (originalAuthDisabled === undefined) {
      delete process.env.WR_AUTH_DISABLED
    } else {
      process.env.WR_AUTH_DISABLED = originalAuthDisabled
    }
  })

  it('returns a 401 with trace headers when Authorization is missing', async () => {
    const response = proxy(makeRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })

    const traceId = response.headers.get(TRACE_ID_HEADER)!
    const spanId = response.headers.get(SPAN_ID_HEADER)!
    const traceParent = response.headers.get(TRACE_PARENT_HEADER)!

    expect(isValidTraceId(traceId)).toBe(true)
    expect(isValidSpanId(spanId)).toBe(true)
    expect(traceParent).toMatch(TRACE_PARENT_PATTERN)
    const match = TRACE_PARENT_PATTERN.exec(traceParent)!
    expect(match[1]).toBe(traceId)
    expect(match[2]).toBe(spanId)
  })

  it('inherits the trace id from an inbound traceparent on the 401 path', async () => {
    const response = proxy(
      makeRequest({ traceparent: `00-${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-01` }),
    )

    expect(response.status).toBe(401)
    expect(response.headers.get(TRACE_ID_HEADER)).toBe(INCOMING_TRACE_ID)
  })

  it('passes requests through when auth is disabled', () => {
    process.env.WR_AUTH_DISABLED = '1'

    const response = proxy(makeRequest())

    expect(isPassThrough(response)).toBe(true)
  })

  it('passes requests through when Authorization is present', () => {
    const response = proxy(makeRequest({ Authorization: 'Bearer wrp_something' }))

    expect(isPassThrough(response)).toBe(true)
  })
})
