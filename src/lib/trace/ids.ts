/**
 * Trace / Span ID 的生成与解析（W3C Trace Context 兼容，读兼容 B3/Sleuth）。
 *
 * 纯函数模块，刻意不加 `server-only`、不 import `node:crypto` 或任何 Node 专属
 * 模块：`src/proxy.ts` 与 jsdom/vitest 环境都要能直接 import（proxy 在 Node
 * runtime 跑，但客户端构建也曾误引过本模块，随机数统一走
 * `globalThis.crypto.getRandomValues`——浏览器、Node、jsdom 都可用）。
 */

export const TRACE_ID_HEADER = 'x-trace-id'
export const SPAN_ID_HEADER = 'x-span-id'
export const TRACE_PARENT_HEADER = 'traceparent'

/** 只接受小写 hex：W3C 规定 trace-id / span-id 为小写。 */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/
/** B3 的 64-bit trace id（Sleuth 默认发这种）。 */
const B3_TRACE_ID_PATTERN = /^[0-9a-f]{16}$/
/** 00-{32hex}-{16hex}-{2hex}，版本与 flags 位都只做形态校验。 */
const TRACE_PARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

function randomHex(byteLength: number): string {
  const buffer = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(buffer)
  let out = ''
  for (const byte of buffer) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/** 32 位小写 hex 且非全 0 才是合法 traceId。 */
export function isValidTraceId(id: string): boolean {
  return typeof id === 'string' && TRACE_ID_PATTERN.test(id) && id !== ZERO_TRACE_ID
}

/** 16 位小写 hex 且非全 0 才是合法 spanId。 */
export function isValidSpanId(id: string): boolean {
  return typeof id === 'string' && SPAN_ID_PATTERN.test(id) && id !== ZERO_SPAN_ID
}

/** 生成 128-bit traceId（32 位小写 hex）。 */
export function newTraceId(): string {
  let id = randomHex(16)
  // 全 0 概率约 2^-128，理论上仍要排除（W3C 明确禁止）。
  while (id === ZERO_TRACE_ID) id = randomHex(16)
  return id
}

/** 生成 64-bit spanId（16 位小写 hex）。 */
export function newSpanId(): string {
  let id = randomHex(8)
  while (id === ZERO_SPAN_ID) id = randomHex(8)
  return id
}

/**
 * 归一化 B3 trace id。
 *
 * Sleuth 默认发 64-bit（16 位 hex）trace id，而本系统内部 traceId 统一是 128-bit
 * （32 位 hex），因此左边补 0 扩到 128-bit；全 0 仍然非法，返回 null。
 */
function normalizeB3TraceId(value: string): string | null {
  if (isValidTraceId(value)) return value
  if (B3_TRACE_ID_PATTERN.test(value)) {
    const padded = value.padStart(32, '0')
    return isValidTraceId(padded) ? padded : null
  }
  return null
}

/**
 * 解析入站请求携带的 traceId。
 *
 * 优先级：`traceparent` → `x-b3-traceid`（Sleuth/B3 兼容）→ `x-trace-id`。
 * 每一层都要求取出的 traceId 合法（32 位小写 hex、非全 0；B3 的 16 位 64-bit id
 * 左补 0 后使用）；非法则继续看下一层，三者都不合法返回 null，由调用方决定重新生成。
 */
export function parseIncomingTraceId(headers: Headers): string | null {
  const traceParent = headers.get(TRACE_PARENT_HEADER)
  if (traceParent) {
    const match = TRACE_PARENT_PATTERN.exec(traceParent.trim())
    if (match) {
      const [, version, traceId, spanId] = match
      // 版本 ff 是 W3C 明令非法值；其余两位 hex 版本都放过（向前兼容）。
      if (version !== 'ff' && isValidTraceId(traceId) && isValidSpanId(spanId)) {
        return traceId
      }
    }
  }

  const b3TraceId = headers.get('x-b3-traceid')
  if (b3TraceId) {
    const normalized = normalizeB3TraceId(b3TraceId.trim())
    if (normalized) return normalized
  }

  const legacyTraceId = headers.get(TRACE_ID_HEADER)
  if (legacyTraceId && isValidTraceId(legacyTraceId.trim())) return legacyTraceId.trim()

  return null
}

/** 拼出出站/响应头用的 `00-{traceId}-{spanId}-01`（flags 恒 01 = sampled）。 */
export function traceParentString(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}
