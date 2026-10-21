import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  generationMessageParts,
  generationPlanJudgments,
  generationProposals,
  generationSessions,
  generationTurns,
  reportEventSnapshots,
  reportVariants,
  reports,
} from '@/lib/db/schema'
import { getReportBundle } from '@/lib/reports/service'

export const GET = withAuth(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const reportId = Number.parseInt((await params).id, 10)
    if (Number.isNaN(reportId)) {
      return NextResponse.json({ error: 'Invalid report ID', code: 'INVALID_ID' }, { status: 400 })
    }

    const bundle = await getReportBundle(reportId)
    if (!bundle) {
      return NextResponse.json({ error: 'Report not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const variants = bundle.variants.length > 0 ? bundle.variants : [{
      id: -bundle.id,
      reportId: bundle.id,
      variant: 'personal' as const,
      sourceDraft: '- No events this week',
      finalContent: bundle.content,
      finalStatus: 'current' as const,
      templateId: null,
      templateName: null,
      templateContent: null,
      structureCompletenessRule: null,
      aiStyle: bundle.aiStyleOverride,
      acceptedProposalId: null,
      sourceRevision: 0,
      createdAt: bundle.createdAt,
      updatedAt: bundle.updatedAt,
    }]
    const personal = variants.find((variant) => variant.variant === 'personal')
    return NextResponse.json({
      ...bundle,
      variants,
      content: personal?.finalContent ?? personal?.sourceDraft ?? bundle.content,
    })
  } catch (error) {
    console.error('GET /api/reports/[id] error:', error)
    return NextResponse.json({ error: 'Failed to fetch report', code: 'FETCH_ERROR' }, { status: 500 })
  }
})

export const PUT = withAuth(async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const reportId = Number.parseInt((await params).id, 10)
    if (Number.isNaN(reportId)) {
      return NextResponse.json({ error: 'Invalid report ID', code: 'INVALID_ID' }, { status: 400 })
    }
    const body = await request.json()
    const db = getDb()
    const existing = await db.query.reports.findFirst({ where: eq(reports.id, reportId) })
    if (!existing) {
      return NextResponse.json({ error: 'Report not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const updated = await db.update(reports).set({
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.title,
      updatedAt: new Date(),
    }).where(eq(reports.id, reportId)).returning()

    return NextResponse.json(updated[0])
  } catch {
    return NextResponse.json({ error: 'Failed to update report', code: 'UPDATE_ERROR' }, { status: 500 })
  }
})

export const DELETE = withAuth(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const reportId = Number.parseInt((await params).id, 10)
    if (Number.isNaN(reportId)) {
      return NextResponse.json({ error: 'Invalid report ID', code: 'INVALID_ID' }, { status: 400 })
    }

    const db = getDb()
    const existing = await db.query.reports.findFirst({ where: eq(reports.id, reportId) })
    if (!existing) {
      return NextResponse.json({ error: 'Report not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const sessionRows = await db.select({ id: generationSessions.id })
      .from(generationSessions)
      .where(eq(generationSessions.reportId, reportId))
    for (const session of sessionRows) {
      const acceptedProposal = await db.select({ id: generationProposals.id })
        .from(generationProposals)
        .where(and(eq(generationProposals.sessionId, session.id), eq(generationProposals.status, 'accepted')))
        .limit(1)
      if (acceptedProposal.length > 0) {
        return NextResponse.json({ error: 'This report contains generation audit records for an accepted final version. Keep the report or archive its sessions first.', code: 'AUDIT_RECORD_REQUIRED' }, { status: 409 })
      }
    }

    db.transaction((tx) => {
      const sessions = tx.select({ id: generationSessions.id })
        .from(generationSessions)
        .where(eq(generationSessions.reportId, reportId))
        .all()
      for (const session of sessions) {
        tx.delete(generationProposals).where(eq(generationProposals.sessionId, session.id)).run()
        tx.delete(generationPlanJudgments).where(eq(generationPlanJudgments.sessionId, session.id)).run()
        tx.delete(generationMessageParts).where(eq(generationMessageParts.sessionId, session.id)).run()
        tx.delete(generationTurns).where(eq(generationTurns.sessionId, session.id)).run()
      }
      tx.delete(generationSessions).where(eq(generationSessions.reportId, reportId)).run()
      tx.delete(reportEventSnapshots).where(eq(reportEventSnapshots.reportId, reportId)).run()
      tx.delete(reportVariants).where(eq(reportVariants.reportId, reportId)).run()
      tx.delete(reports).where(eq(reports.id, reportId)).run()
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed to delete report', code: 'DELETE_ERROR' }, { status: 500 })
  }
})
