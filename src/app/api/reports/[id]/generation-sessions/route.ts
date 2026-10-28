import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import type { AudienceVariant } from '@/lib/db/schema'
import {
  createGenerationSession,
  GenerationServiceError,
  listGenerationSessions,
} from '@/lib/generation/service'

type RouteContext = { params: Promise<{ id: string }> }

function reportIdFrom(value: string): number | null {
  const id = Number.parseInt(value, 10)
  return Number.isNaN(id) ? null : id
}

function failure(error: unknown) {
  if (error instanceof GenerationServiceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  console.error('generation sessions route error:', error)
  return NextResponse.json({ error: 'Generation session operation failed', code: 'GENERATION_SESSION_ERROR' }, { status: 500 })
}

export const GET = withAuth(async function GET(request: Request, { params }: RouteContext) {
  const reportId = reportIdFrom((await params).id)
  if (reportId == null) return NextResponse.json({ error: 'Invalid report ID', code: 'INVALID_ID' }, { status: 400 })
  const value = new URL(request.url).searchParams.get('variant')
  const variant: AudienceVariant | undefined = value === 'leadership' || value === 'personal' ? value : undefined
  try {
    return NextResponse.json({ sessions: await listGenerationSessions(reportId, variant) })
  } catch (error) {
    return failure(error)
  }
})

export const POST = withAuth(async function POST(request: Request, { params }: RouteContext) {
  const reportId = reportIdFrom((await params).id)
  if (reportId == null) return NextResponse.json({ error: 'Invalid report ID', code: 'INVALID_ID' }, { status: 400 })
  try {
    const body = await request.json()
    const variant = body.variant === 'leadership' || body.variant === 'personal' ? body.variant : null
    if (!variant || typeof body.templateId !== 'string' || !body.templateId) {
      return NextResponse.json({ error: 'Select an audience variant and template', code: 'INVALID_INPUT' }, { status: 400 })
    }
    const session = await createGenerationSession({
      reportId,
      variant,
      templateId: body.templateId,
      styleOverride: typeof body.styleOverride === 'string' ? body.styleOverride : undefined,
    })
    return NextResponse.json(session, { status: 201 })
  } catch (error) {
    return failure(error)
  }
})
