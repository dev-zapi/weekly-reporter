import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { GenerationServiceError, refreshHistoricalQuery } from '@/lib/generation/service'

export const runtime = 'nodejs'
type RouteContext = { params: Promise<{ id: string; sessionId: string }> }

export const POST = withAuth(async function POST(request: Request, { params }: RouteContext) {
  const values = await params
  const reportId = Number.parseInt(values.id, 10)
  const sessionId = Number.parseInt(values.sessionId, 10)
  if (Number.isNaN(reportId) || Number.isNaN(sessionId)) return NextResponse.json({ error: 'Invalid ID', code: 'INVALID_ID' }, { status: 400 })
  try {
    const body = await request.json().catch(() => ({})) as { snapshotId?: number }
    return NextResponse.json(await refreshHistoricalQuery({ reportId, sessionId, snapshotId: body.snapshotId }))
  } catch (error) {
    if (error instanceof GenerationServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    return NextResponse.json({ error: 'Failed to refresh historical query', code: 'QUERY_REFRESH_FAILED' }, { status: 500 })
  }
})
