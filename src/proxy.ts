import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_HEADER,
  newSpanId,
  newTraceId,
  parseIncomingTraceId,
  traceParentString,
} from '@/lib/trace/ids'

export const config = {
  matcher: '/api/:path*',
}

/**
 * 乐观拦截：只做早拒，兜底「漏改 route」。
 *
 * 职责边界：
 * - 有 `Authorization` 头 → 一律放行，不在这里校验 token（权威判定在 `withAuth`）
 * - 不写审计：proxy 观测不到路由的最终 HTTP status
 * - 只管自己直接产出的 401 响应带 trace 头；成功响应的 trace 头由 `withAuth` 统一负责
 */
export function proxy(request: NextRequest) {
  if (process.env.WR_AUTH_DISABLED === '1') return NextResponse.next()

  if (!request.headers.get('authorization')) {
    const traceId = parseIncomingTraceId(request.headers) ?? newTraceId()
    const spanId = newSpanId()
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: {
          [TRACE_ID_HEADER]: traceId,
          [SPAN_ID_HEADER]: spanId,
          [TRACE_PARENT_HEADER]: traceParentString(traceId, spanId),
        },
      },
    )
  }

  return NextResponse.next()
}
