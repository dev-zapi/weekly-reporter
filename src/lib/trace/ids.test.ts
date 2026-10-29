import { describe, it, expect } from 'vitest'
import {
  SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_HEADER,
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  parseIncomingTraceId,
  traceParentString,
} from './ids'

/** 一组合法的固定 ID，便于断言「原样取用」。 */
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const OTHER_TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const SPAN_ID = '00f067aa0ba902b7'

function headers(init: Record<string, string>): Headers {
  return new Headers(init)
}

describe('header constants', () => {
  it('exposes the canonical lowercase header names', () => {
    expect(TRACE_ID_HEADER).toBe('x-trace-id')
    expect(SPAN_ID_HEADER).toBe('x-span-id')
    expect(TRACE_PARENT_HEADER).toBe('traceparent')
  })
})

describe('isValidTraceId', () => {
  it('accepts 32 lowercase hex characters', () => {
    expect(isValidTraceId(TRACE_ID)).toBe(true)
    expect(isValidTraceId('0af7651916cd43dd8448eb211c80319c')).toBe(true)
  })

  it('rejects all-zero ids', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false)
  })

  it('rejects uppercase hex', () => {
    expect(isValidTraceId(TRACE_ID.toUpperCase())).toBe(false)
  })

  it('rejects wrong lengths and non-hex characters', () => {
    expect(isValidTraceId('')).toBe(false)
    expect(isValidTraceId('abc')).toBe(false)
    expect(isValidTraceId(TRACE_ID.slice(0, 31))).toBe(false)
    expect(isValidTraceId(`${TRACE_ID}0`)).toBe(false)
    expect(isValidTraceId('g'.repeat(32))).toBe(false)
    expect(isValidTraceId(`${TRACE_ID.slice(0, 31)}-`)).toBe(false)
  })
})

describe('isValidSpanId', () => {
  it('accepts 16 lowercase hex characters', () => {
    expect(isValidSpanId(SPAN_ID)).toBe(true)
  })

  it('rejects all-zero ids, uppercase and wrong lengths', () => {
    expect(isValidSpanId('0'.repeat(16))).toBe(false)
    expect(isValidSpanId(SPAN_ID.toUpperCase())).toBe(false)
    expect(isValidSpanId(SPAN_ID.slice(0, 15))).toBe(false)
    expect(isValidSpanId(`${SPAN_ID}0`)).toBe(false)
    expect(isValidSpanId('')).toBe(false)
  })
})

describe('newTraceId / newSpanId', () => {
  it('generates a valid 32-hex trace id', () => {
    const id = newTraceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(isValidTraceId(id)).toBe(true)
  })

  it('generates a valid 16-hex span id', () => {
    const id = newSpanId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(isValidSpanId(id)).toBe(true)
  })

  it('does not repeat across calls', () => {
    const traceIds = new Set(Array.from({ length: 100 }, () => newTraceId()))
    const spanIds = new Set(Array.from({ length: 100 }, () => newSpanId()))
    expect(traceIds.size).toBe(100)
    expect(spanIds.size).toBe(100)
  })
})

describe('traceParentString', () => {
  it('formats 00-{traceId}-{spanId}-01', () => {
    expect(traceParentString(TRACE_ID, SPAN_ID)).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
  })
})

describe('parseIncomingTraceId', () => {
  it('extracts the trace id from a valid traceparent', () => {
    const incoming = headers({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` })
    expect(parseIncomingTraceId(incoming)).toBe(TRACE_ID)
  })

  it('prefers traceparent over x-b3-traceid and x-trace-id', () => {
    const incoming = headers({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      'x-b3-traceid': OTHER_TRACE_ID,
      'x-trace-id': OTHER_TRACE_ID,
    })
    expect(parseIncomingTraceId(incoming)).toBe(TRACE_ID)
  })

  it('prefers x-b3-traceid over x-trace-id when traceparent is absent', () => {
    const incoming = headers({
      'x-b3-traceid': OTHER_TRACE_ID,
      'x-trace-id': TRACE_ID,
    })
    expect(parseIncomingTraceId(incoming)).toBe(OTHER_TRACE_ID)
  })

  it('falls back to x-trace-id alone', () => {
    const incoming = headers({ 'x-trace-id': TRACE_ID })
    expect(parseIncomingTraceId(incoming)).toBe(TRACE_ID)
  })

  it('left-pads a 64-bit B3 trace id to 128-bit', () => {
    const incoming = headers({ 'x-b3-traceid': 'a3ce929d0e0e4736' })
    expect(parseIncomingTraceId(incoming)).toBe('0000000000000000a3ce929d0e0e4736')
  })

  it('rejects an all-zero 64-bit B3 trace id', () => {
    expect(parseIncomingTraceId(headers({ 'x-b3-traceid': '0'.repeat(16) }))).toBeNull()
  })

  it('falls through an invalid traceparent to the next valid source', () => {
    const invalidTraceParents = [
      `00-${'0'.repeat(32)}-${SPAN_ID}-01`, // 全 0 traceId
      `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`, // 大写
      `00-${TRACE_ID}-${SPAN_ID}`, // 少一段
      `00-${TRACE_ID}-${SPAN_ID}-01-extra`, // 多一段
      `00-${TRACE_ID}-${'0'.repeat(16)}-01`, // 全 0 spanId
      `ff-${TRACE_ID}-${SPAN_ID}-01`, // 非法版本
      'garbage',
    ]

    for (const traceparent of invalidTraceParents) {
      const incoming = headers({ traceparent, 'x-b3-traceid': OTHER_TRACE_ID })
      expect(parseIncomingTraceId(incoming)).toBe(OTHER_TRACE_ID)
    }
  })

  it('rejects malformed or invalid B3 / legacy headers', () => {
    expect(parseIncomingTraceId(headers({ 'x-b3-traceid': 'abc' }))).toBeNull()
    expect(parseIncomingTraceId(headers({ 'x-b3-traceid': TRACE_ID.toUpperCase() }))).toBeNull()
    expect(parseIncomingTraceId(headers({ 'x-trace-id': '0'.repeat(32) }))).toBeNull()
    expect(parseIncomingTraceId(headers({ 'x-trace-id': 'not-a-trace-id' }))).toBeNull()
  })

  it('returns null when no trace header is present', () => {
    expect(parseIncomingTraceId(headers({}))).toBeNull()
  })

  it('returns null when a valid traceparent carries an all-zero trace id and nothing else does', () => {
    expect(
      parseIncomingTraceId(headers({ traceparent: `00-${'0'.repeat(32)}-${SPAN_ID}-01` })),
    ).toBeNull()
  })
})
