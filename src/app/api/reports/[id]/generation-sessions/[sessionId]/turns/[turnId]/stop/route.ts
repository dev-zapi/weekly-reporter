import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { GenerationServiceError, getGenerationSessionDetail } from '@/lib/generation/service'
import { markTurnStopped } from '@/lib/generation/stream'

type RouteContext = { params: Promise<{ id: string; sessionId: string; turnId: string }> }

export const POST = withAuth(async function POST(_request: Request, { params }: RouteContext) {
  const values = await params
  const reportId = Number.parseInt(values.id, 10)
  const sessionId = Number.parseInt(values.sessionId, 10)
  const turnId = Number.parseInt(values.turnId, 10)
  if ([reportId, sessionId, turnId].some(Number.isNaN)) {
    return NextResponse.json({ error: '无效的ID', code: 'INVALID_ID' }, { status: 400 })
  }
  try {
    const detail = await getGenerationSessionDetail(reportId, sessionId)
    if (!detail || !detail.turns.some((turn) => turn.id === turnId)) {
      return NextResponse.json({ error: '生成轮次不存在', code: 'TURN_NOT_FOUND' }, { status: 404 })
    }
    return NextResponse.json(await markTurnStopped(turnId))
  } catch (error) {
    if (error instanceof GenerationServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return NextResponse.json({ error: '停止生成失败', code: 'STOP_ERROR' }, { status: 500 })
  }
})
