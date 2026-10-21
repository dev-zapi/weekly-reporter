import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const config = {
  matcher: '/api/:path*',
}

/**
 * 乐观拦截：只做早拒，兜底「漏改 route」。
 *
 * 职责边界：
 * - 有 `Authorization` 头 → 一律放行，不在这里校验 token（权威判定在 `withAuth`）
 * - 不写审计：proxy 观测不到路由的最终 HTTP status
 */
export function proxy(request: NextRequest) {
  if (process.env.WR_AUTH_DISABLED === '1') return NextResponse.next()

  if (!request.headers.get('authorization')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}
