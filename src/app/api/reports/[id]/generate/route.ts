import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getAIStyle } from '@/lib/ai/styles'
import { generateFinalReport } from '@/lib/ai'
import { AIConfigError } from '@/lib/ai/provider'
import { getReportBundle, getTemplateSelection } from '@/lib/reports/service'
import { isEmptySourceDraft } from '@/lib/reports/source-draft'

type RouteContext = { params: Promise<{ id: string }> }

export const POST = withAuth(async function POST(request: Request, { params }: RouteContext) {
  try {
    const reportId = Number.parseInt((await params).id, 10)
    if (Number.isNaN(reportId)) {
      return NextResponse.json({ error: 'Invalid report ID', code: 'INVALID_ID' }, { status: 400 })
    }

    const body = await request.json()
    const variant = body.variant === 'leadership' || body.variant === 'personal' ? body.variant : null
    if (!variant || typeof body.templateId !== 'string' || !body.templateId) {
      return NextResponse.json({ error: 'Select an audience variant and template', code: 'INVALID_INPUT' }, { status: 400 })
    }

    const bundle = await getReportBundle(reportId)
    if (!bundle) {
      return NextResponse.json({ error: 'Report not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const reportVariant = bundle.variants.find((item) => item.variant === variant)
    if (!reportVariant) {
      return NextResponse.json({ error: 'Report variant not found', code: 'VARIANT_NOT_FOUND' }, { status: 404 })
    }
    if (reportVariant.sourceRevision === 0 || isEmptySourceDraft(reportVariant.sourceDraft)) {
      return NextResponse.json({ error: 'No events are available to generate the final report', code: 'EMPTY_SOURCE_DRAFT' }, { status: 400 })
    }

    const template = await getTemplateSelection(body.templateId)
    if (!template) {
      return NextResponse.json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' }, { status: 404 })
    }

    const styleKey = typeof body.styleOverride === 'string' && body.styleOverride
      ? body.styleOverride
      : template.aiStyle
    const style = await getAIStyle(styleKey)
    const effectiveStyleKey = typeof body.styleOverride === 'string' && body.styleOverride
      ? body.styleOverride
      : template.aiStyle
    const result = await generateFinalReport({
      sourceDraft: reportVariant.sourceDraft,
      template: template.content,
      variant,
      weekStart: bundle.weekStart,
      weekEnd: bundle.weekEnd,
      stylePrompt: style.systemPrompt,
    }, style.temperature)

    return NextResponse.json({
      content: result.content,
      summary: result.summary,
      variant,
      template,
      aiStyle: effectiveStyleKey,
      sourceRevision: reportVariant.sourceRevision,
    })
  } catch (error) {
    console.error('POST /api/reports/[id]/generate error:', error)
    if (error instanceof AIConfigError) {
      return NextResponse.json({ error: error.message, code: 'AI_NOT_CONFIGURED' }, { status: 400 })
    }
    return NextResponse.json(
      { error: 'Failed to generate final report', code: 'GENERATION_ERROR', details: String(error) },
      { status: 500 },
    )
  }
})
