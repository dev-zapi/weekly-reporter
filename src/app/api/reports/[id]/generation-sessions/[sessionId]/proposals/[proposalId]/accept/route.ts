import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { acceptGenerationProposal, GenerationServiceError } from '@/lib/generation/service'

type RouteContext = { params: Promise<{ id: string; sessionId: string; proposalId: string }> }

export const POST = withAuth(async function POST(_request: Request, { params }: RouteContext) {
  const values = await params
  const reportId = Number.parseInt(values.id, 10)
  const sessionId = Number.parseInt(values.sessionId, 10)
  const proposalId = Number.parseInt(values.proposalId, 10)
  if ([reportId, sessionId, proposalId].some(Number.isNaN)) {
    return NextResponse.json({ error: '无效的ID', code: 'INVALID_ID' }, { status: 400 })
  }
  try {
    return NextResponse.json(await acceptGenerationProposal({ reportId, sessionId, proposalId }))
  } catch (error) {
    if (error instanceof GenerationServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('accept generation proposal error:', error)
    return NextResponse.json({ error: '保存候选终版失败', code: 'ACCEPT_PROPOSAL_ERROR' }, { status: 500 })
  }
})
