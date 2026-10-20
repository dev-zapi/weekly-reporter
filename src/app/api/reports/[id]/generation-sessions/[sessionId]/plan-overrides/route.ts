import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { appendPlanOverride } from '@/lib/generation/plan-override'
import { GenerationServiceError } from '@/lib/generation/service'
import type { PlanOverrideAction } from '@/lib/generation/plan'

type RouteContext = { params: Promise<{ id: string; sessionId: string }> }

function failure(error: unknown) {
  if (error instanceof GenerationServiceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  console.error('plan override route error:', error)
  return NextResponse.json({ error: 'Failed to record plan override', code: 'PLAN_OVERRIDE_ERROR' }, { status: 500 })
}

export const POST = withAuth(async function POST(request: Request, { params }: RouteContext) {
  const values = await params
  const reportId = Number.parseInt(values.id, 10)
  const sessionId = Number.parseInt(values.sessionId, 10)
  if (Number.isNaN(reportId) || Number.isNaN(sessionId)) {
    return NextResponse.json({ error: 'Invalid ID', code: 'INVALID_ID' }, { status: 400 })
  }

  try {
    const body = await request.json()
    const action: PlanOverrideAction | null = ['keep', 'drop', 'rewrite', 're-add'].includes(body.action)
      ? body.action
      : null
    if (!action) {
      return NextResponse.json({ error: 'Invalid plan override action', code: 'INVALID_PLAN_OVERRIDE' }, { status: 400 })
    }
    const record = await appendPlanOverride({
      reportId,
      sessionId,
      action,
      itemId: typeof body.itemId === 'string' ? body.itemId : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
    })
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    return failure(error)
  }
})
