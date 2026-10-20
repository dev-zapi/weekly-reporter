import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'

/**
 * Weekly-report templates are now instructions for AI final generation. The
 * old deterministic event/placeholder renderer is intentionally unavailable.
 */
export const GET = withAuth(async function GET() {
  return NextResponse.json(
    {
      error: '周报模板不再由系统直接渲染，请使用终版生成接口',
      code: 'TEMPLATE_RENDER_REMOVED',
    },
    { status: 410 },
  )
})
