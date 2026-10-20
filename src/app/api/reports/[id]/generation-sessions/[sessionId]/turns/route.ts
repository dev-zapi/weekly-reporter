import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { GenerationServiceError } from '@/lib/generation/service'
import { createGenerationEventStream, prepareGenerationTurn } from '@/lib/generation/stream'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string; sessionId: string }> }

export const POST = withAuth(async function POST(request: Request, { params }: RouteContext) {
  const values = await params
  const reportId = Number.parseInt(values.id, 10)
  const sessionId = Number.parseInt(values.sessionId, 10)
  if (Number.isNaN(reportId) || Number.isNaN(sessionId)) {
    return NextResponse.json({ error: 'Invalid ID', code: 'INVALID_ID' }, { status: 400 })
  }

  try {
    const body = await request.json()
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return NextResponse.json({ error: 'Message is required', code: 'EMPTY_MESSAGE' }, { status: 400 })
    }
    const prepared = await prepareGenerationTurn({ reportId, sessionId, userMessage: body.message })
    return new Response(createGenerationEventStream(prepared, request.signal), {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof GenerationServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('generation turn route error:', error)
    return NextResponse.json({ error: 'Failed to start AI generation', code: 'GENERATION_START_ERROR' }, { status: 500 })
  }
})
