import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { format, parseISO, subDays } from 'date-fns'
import { getDb } from '@/lib/db'
import {
  generationMessageParts,
  generationPlanJudgments,
  generationPlanOverrides,
  generationProposals,
  generationSessions,
  generationTurns,
  rawEvents,
  reportEventSnapshots,
  reportVariants,
  reports,
} from '@/lib/db/schema'

export const runtime = 'nodejs'

type FixtureReport = { id: number; kind: 'current' | 'stale' | 'legacy' }

function enabled() {
  return process.env.E2E_FIXTURES === '1'
}

export const POST = withAuth(async function POST(request: Request) {
  if (!enabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await request.json().catch(() => null) as { action?: string; marker?: string; mode?: string; targetReportId?: unknown } | null
  if (!body || !['historical', 'report-query'].includes(body.action ?? '') || typeof body.marker !== 'string' || !body.marker.trim()) {
    return NextResponse.json({ error: 'A marker and historical action are required', code: 'INVALID_INPUT' }, { status: 400 })
  }

  const marker = body.marker.trim().slice(0, 120)
  const db = getDb()
  const now = new Date()
  const rows: FixtureReport[] = []
  if (body.action === 'report-query') {
    if (!Number.isInteger(body.targetReportId) || Number(body.targetReportId) <= 0) {
      return NextResponse.json({ error: 'A target report ID is required', code: 'INVALID_INPUT' }, { status: 400 })
    }
    const targetReportId = Number(body.targetReportId)
    const target = db.select().from(reports).where(eq(reports.id, targetReportId)).get()
    if (!target) return NextResponse.json({ error: 'Target report not found', code: 'REPORT_NOT_FOUND' }, { status: 404 })

    const targetStart = parseISO(target.weekStart)
    const reportIds: number[] = []
    const createReport = (input: {
      title: string
      weekStart: Date
      weekEnd: Date
      variants: Array<{
        audience: 'leadership' | 'personal'
        finalStatus: 'current' | 'stale' | 'none'
        finalContent: string | null
        accepted: boolean
      }>
    }) => {
      const report = db.insert(reports).values({
        title: input.title,
        content: `# raw source must stay private: ${input.title}`,
        weekStart: format(input.weekStart, 'yyyy-MM-dd'),
        weekEnd: format(input.weekEnd, 'yyyy-MM-dd'),
        createdAt: now,
        updatedAt: now,
      }).returning().get()
      db.insert(reportVariants).values(input.variants.map((variant, index) => ({
        reportId: report.id,
        variant: variant.audience,
        sourceDraft: `- private ${variant.audience} source draft for ${input.title}`,
        finalContent: variant.finalContent,
        finalStatus: variant.finalStatus,
        acceptedProposalId: variant.accepted ? report.id * 100 + index + 1 : null,
        sourceRevision: 1,
        createdAt: now,
        updatedAt: now,
      }))).run()
      reportIds.push(report.id)
      return report.id
    }

    const adjacentReportId = body.mode === 'no-adjacent' ? undefined : createReport({
      title: `${marker} previous adjacent`,
      weekStart: subDays(targetStart, 7),
      weekEnd: subDays(targetStart, 1),
      variants: [
        { audience: 'personal', finalStatus: 'current', finalContent: `# ${marker} previous adjacent personal final`, accepted: true },
        { audience: 'leadership', finalStatus: 'current', finalContent: `# ${marker} previous adjacent leadership final`, accepted: true },
      ],
    })
    const sameAudienceReportId = createReport({
      title: `${marker} personal history`,
      weekStart: subDays(targetStart, 21),
      weekEnd: subDays(targetStart, 15),
      variants: [
        { audience: 'personal', finalStatus: 'current', finalContent: `# ${marker} searchable personal final`, accepted: true },
        { audience: 'leadership', finalStatus: 'none', finalContent: null, accepted: false },
      ],
    })
    const crossAudienceReportId = createReport({
      title: `${marker} leadership only`,
      weekStart: subDays(targetStart, 14),
      weekEnd: subDays(targetStart, 8),
      variants: [
        { audience: 'leadership', finalStatus: 'current', finalContent: `# ${marker} leadership secret`, accepted: true },
        { audience: 'personal', finalStatus: 'none', finalContent: null, accepted: false },
      ],
    })
    const longReportId = createReport({
      title: `${marker} long content`,
      weekStart: subDays(targetStart, 63),
      weekEnd: subDays(targetStart, 57),
      variants: [{ audience: 'personal', finalStatus: 'current', finalContent: `# ${marker} long content\n\n${'x'.repeat(41_000)}`, accepted: true }],
    })
    const currentLegacyReportId = createReport({
      title: `${marker} legacy current excluded`,
      weekStart: subDays(targetStart, 49),
      weekEnd: subDays(targetStart, 43),
      variants: [{ audience: 'personal', finalStatus: 'current', finalContent: `# ${marker} legacy current secret`, accepted: false }],
    })
    const staleReportId = createReport({
      title: `${marker} stale excluded`,
      weekStart: subDays(targetStart, 28),
      weekEnd: subDays(targetStart, 22),
      variants: [
        { audience: 'personal', finalStatus: 'stale', finalContent: `# ${marker} personal stale secret`, accepted: true },
        { audience: 'leadership', finalStatus: 'stale', finalContent: `# ${marker} leadership stale secret`, accepted: true },
      ],
    })
    const legacyReportId = db.insert(reports).values({
      title: `${marker} legacy readable`,
      content: `# ${marker} legacy readable content\n\n${marker} legacy grep target`,
      weekStart: format(subDays(targetStart, 56), 'yyyy-MM-dd'),
      weekEnd: format(subDays(targetStart, 50), 'yyyy-MM-dd'),
      createdAt: now,
      updatedAt: now,
    }).returning().get().id
    reportIds.push(legacyReportId)
    const noneReportId = createReport({
      title: `${marker} none excluded`,
      weekStart: subDays(targetStart, 35),
      weekEnd: subDays(targetStart, 29),
      variants: [
        { audience: 'personal', finalStatus: 'none', finalContent: null, accepted: false },
        { audience: 'leadership', finalStatus: 'none', finalContent: null, accepted: false },
      ],
    })
    const unacceptedReportId = createReport({
      title: `${marker} unaccepted excluded`,
      weekStart: subDays(targetStart, 42),
      weekEnd: subDays(targetStart, 36),
      variants: [
        { audience: 'personal', finalStatus: 'none', finalContent: `# ${marker} personal unaccepted preview secret`, accepted: false },
        { audience: 'leadership', finalStatus: 'none', finalContent: `# ${marker} leadership unaccepted preview secret`, accepted: false },
      ],
    })
    return NextResponse.json({
      reportIds,
      adjacentReportId,
      sameAudienceReportId,
      crossAudienceReportId,
      longReportId,
      currentLegacyReportId,
      staleReportId,
      legacyReportId,
      noneReportId,
      unacceptedReportId,
    }, { status: 201 })
  }
  const createModern = (kind: 'current' | 'stale') => {
    const report = db.insert(reports).values({
      title: `${marker} ${kind} history`,
      content: `# ${kind} history`,
      weekStart: kind === 'current' ? '2026-12-21' : '2026-12-14',
      weekEnd: kind === 'current' ? '2026-12-27' : '2026-12-20',
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    const finalStatus = kind === 'current' ? 'current' as const : 'stale' as const
    db.insert(reportVariants).values(['leadership', 'personal'].map((variant) => ({
      reportId: report.id,
      variant: variant as 'leadership' | 'personal',
      sourceDraft: `- ${marker} ${variant} source`,
      finalContent: `# ${marker} ${variant} final`,
      finalStatus,
      sourceRevision: 1,
      createdAt: now,
      updatedAt: now,
    }))).run()
    rows.push({ id: report.id, kind })
  }
  createModern('current')
  createModern('stale')
  const legacy = db.insert(reports).values({
    title: `${marker} legacy history`,
    content: `# ${marker} legacy final`,
    weekStart: '2026-12-07',
    weekEnd: '2026-12-13',
    createdAt: now,
    updatedAt: now,
  }).returning().get()
  rows.push({ id: legacy.id, kind: 'legacy' })
  return NextResponse.json({ reports: rows }, { status: 201 })
})

export const DELETE = withAuth(async function DELETE(request: Request) {
  if (!enabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await request.json().catch(() => null) as { reportIds?: unknown; eventIds?: unknown } | null
  const ids = Array.isArray(body?.reportIds) ? body.reportIds.filter((value): value is number => Number.isInteger(value) && value > 0) : []
  const eventIds = Array.isArray(body?.eventIds) ? body.eventIds.filter((value): value is number => Number.isInteger(value) && value > 0) : []
  if (ids.length === 0 && eventIds.length === 0) return NextResponse.json({ deleted: 0 })
  const db = getDb()
  db.transaction((tx) => {
    if (ids.length > 0) {
      const sessions = tx.select({ id: generationSessions.id }).from(generationSessions).where(inArray(generationSessions.reportId, ids)).all()
      for (const session of sessions) {
        tx.delete(generationProposals).where(eq(generationProposals.sessionId, session.id)).run()
        tx.delete(generationPlanJudgments).where(eq(generationPlanJudgments.sessionId, session.id)).run()
        tx.delete(generationPlanOverrides).where(eq(generationPlanOverrides.sessionId, session.id)).run()
        tx.delete(generationMessageParts).where(eq(generationMessageParts.sessionId, session.id)).run()
        tx.delete(generationTurns).where(eq(generationTurns.sessionId, session.id)).run()
      }
      tx.delete(generationSessions).where(inArray(generationSessions.reportId, ids)).run()
      tx.delete(reportEventSnapshots).where(inArray(reportEventSnapshots.reportId, ids)).run()
      tx.delete(reportVariants).where(inArray(reportVariants.reportId, ids)).run()
      tx.delete(reports).where(inArray(reports.id, ids)).run()
    }
    if (eventIds.length > 0) tx.delete(rawEvents).where(inArray(rawEvents.id, eventIds)).run()
  })
  return NextResponse.json({ deleted: ids.length + eventIds.length })
})
