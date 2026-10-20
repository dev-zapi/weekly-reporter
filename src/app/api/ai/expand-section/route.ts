import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getStyleFromTemplate } from '@/lib/ai/style-helpers'
import { getAIStyle } from '@/lib/ai/styles'
import { expandSection } from '@/lib/ai'
import { AIConfigError } from '@/lib/ai/provider'
import type { AIStyle } from '@/lib/db/schema'

interface ExpandSectionRequest {
  sectionTitle: string
  existingItems: string[]
  events: string[]
  templateId?: number
  styleOverride?: AIStyle
}

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body: ExpandSectionRequest = await request.json()

    if (!body.sectionTitle || typeof body.sectionTitle !== 'string') {
      return NextResponse.json(
        { error: 'Section title is required', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }

    if (!Array.isArray(body.existingItems)) {
      return NextResponse.json(
        { error: 'Existing items must be an array', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }

    if (!Array.isArray(body.events)) {
      return NextResponse.json(
        { error: 'Events must be an array', code: 'INVALID_INPUT' },
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

    const expandedItems = await expandSection(
      body.sectionTitle,
      body.existingItems,
      body.events,
      styleConfig.systemPrompt,
      styleConfig.temperature
    )

    const addedCount = expandedItems.filter(item => item.source === 'generated').length

    return NextResponse.json({
      expandedItems,
      addedCount,
      message: `Added ${addedCount} new items`,
    })
  } catch (error) {
    console.error('POST /api/ai/expand-section error:', error)
    if (error instanceof AIConfigError) {
      return NextResponse.json(
        { error: error.message, code: 'AI_NOT_CONFIGURED' },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to expand section', code: 'EXPAND_ERROR', details: String(error) },
      { status: 500 }
    )
  }
})
