import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getStyleFromTemplate } from '@/lib/ai/style-helpers'
import { getAIStyle } from '@/lib/ai/styles'
import { unifyStyle } from '@/lib/ai'
import { AIConfigError } from '@/lib/ai/provider'
import type { AIStyle } from '@/lib/db/schema'

interface UnifyStyleRequest {
  reportContent: string
  templateId?: number
  styleOverride?: AIStyle
}

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body: UnifyStyleRequest = await request.json()

    if (!body.reportContent || typeof body.reportContent !== 'string') {
      return NextResponse.json(
        { error: 'Report content is required', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }

    let styleConfig
    if (body.templateId) {
      styleConfig = await getStyleFromTemplate(body.templateId)
    } else if (body.styleOverride) {
      styleConfig = await getAIStyle(body.styleOverride)
    } else {
      styleConfig = await getAIStyle()
    }

    const { unifiedContent, changesCount } = await unifyStyle(
      body.reportContent,
      styleConfig.systemPrompt,
      styleConfig.temperature
    )

    return NextResponse.json({
      unifiedContent,
      changesCount,
      message: `Style unified with ${changesCount} changes`,
    })
  } catch (error) {
    console.error('POST /api/ai/unify-style error:', error)
    if (error instanceof AIConfigError) {
      return NextResponse.json(
        { error: error.message, code: 'AI_NOT_CONFIGURED' },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to unify style', code: 'UNIFY_ERROR', details: String(error) },
      { status: 500 }
    )
  }
})
