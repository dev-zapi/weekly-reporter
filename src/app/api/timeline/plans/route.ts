import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getTimelinePlanProjection } from '@/lib/reports/timeline-plans'

export const runtime = 'nodejs'

export const GET = withAuth(async function GET() {
  try {
    return NextResponse.json(await getTimelinePlanProjection())
  } catch (error) {
    console.error('GET /api/timeline/plans error:', error)
    return NextResponse.json(
      { error: 'Failed to load timeline plans', code: 'FETCH_ERROR' },
      { status: 500 },
    )
  }
})
