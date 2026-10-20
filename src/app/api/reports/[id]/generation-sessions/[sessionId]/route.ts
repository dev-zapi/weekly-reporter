import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import {
  archiveGenerationSession,
  GenerationServiceError,
  getGenerationSessionDetail,
  renameGenerationSession,
} from '@/lib/generation/service'

type RouteContext = { params: Promise<{ id: string; sessionId: string }> }

function idsFrom(params: { id: string; sessionId: string }) {
  const reportId = Number.parseInt(params.id, 10)
  const sessionId = Number.parseInt(params.sessionId, 10)
  return Number.isNaN(reportId) || Number.isNaN(sessionId) ? null : { reportId, sessionId }
}

function failure(error: unknown) {
  if (error instanceof GenerationServiceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  console.error('generation session route error:', error)
  return NextResponse.json({ error: 'Generation session operation failed', code: 'GENERATION_SESSION_ERROR' }, { status: 500 })
}

export const GET = withAuth(async function GET(_request: Request, { params }: RouteContext) {
  const ids = idsFrom(await params)
  if (!ids) return NextResponse.json({ error: 'Invalid ID', code: 'INVALID_ID' }, { status: 400 })
  try {
    const session = await getGenerationSessionDetail(ids.reportId, ids.sessionId)
    if (!session) return NextResponse.json({ error: 'Generation session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 })
    return NextResponse.json(session)
  } catch (error) {
    return failure(error)
  }
})

export const PATCH = withAuth(async function PATCH(request: Request, { params }: RouteContext) {
  const ids = idsFrom(await params)
  if (!ids) return NextResponse.json({ error: 'Invalid ID', code: 'INVALID_ID' }, { status: 400 })
  try {
    const body = await request.json()
    if (typeof body.title !== 'string') {
      return NextResponse.json({ error: 'Session title is required', code: 'INVALID_TITLE' }, { status: 400 })
    }
    return NextResponse.json(await renameGenerationSession(ids.reportId, ids.sessionId, body.title))
  } catch (error) {
    return failure(error)
  }
})

export const DELETE = withAuth(async function DELETE(_request: Request, { params }: RouteContext) {
  const ids = idsFrom(await params)
  if (!ids) return NextResponse.json({ error: '无效的ID', code: 'INVALID_ID' }, { status: 400 })
  try {
    return NextResponse.json(await archiveGenerationSession(ids.reportId, ids.sessionId))
  } catch (error) {
    return failure(error)
  }
})
