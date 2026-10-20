import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { format, parseISO, startOfWeek, subDays } from 'date-fns'
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
  if (!body || !['historical', 'timeline', 'carry-forward', 'report-query'].includes(body.action ?? '') || typeof body.marker !== 'string' || !body.marker.trim()) {
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
  if (body.action === 'carry-forward') {
    const empty = body.mode === 'empty'
    const excludedStatus = body.mode === 'stale' ? 'stale' : body.mode === 'none' ? 'none' : 'current'
    const targetWeekStart = empty ? '2027-02-01' : '2027-01-11'
    const targetWeekEnd = empty ? '2027-02-07' : '2027-01-17'
    const reportIds: number[] = []
    const eventIds: number[] = []
    if (!empty) {
      const previous = db.insert(reports).values({
        title: `${marker} previous cycle`,
        content: `# ${marker} previous cycle`,
        weekStart: '2027-01-04',
        weekEnd: '2027-01-10',
        createdAt: now,
        updatedAt: now,
      }).returning().get()
      if (body.mode !== 'legacy') {
        db.insert(reportVariants).values([
          {
            reportId: previous.id,
            variant: 'leadership' as const,
            sourceDraft: `- ${marker} leadership source`,
            finalContent: `# ${marker} leadership final\n\n## 下周计划\n\n- ${marker} leadership carry`,
            finalStatus: excludedStatus as 'current' | 'stale' | 'none',
            acceptedProposalId: excludedStatus === 'current' ? 101 : null,
            sourceRevision: 1,
            createdAt: now,
            updatedAt: now,
          },
          {
            reportId: previous.id,
            variant: 'personal' as const,
            sourceDraft: `- ${marker} personal source`,
            finalContent: `# ${marker} personal final\n\n## 下周计划\n\n- ${marker} personal carry`,
            finalStatus: excludedStatus as 'current' | 'stale' | 'none',
            acceptedProposalId: excludedStatus === 'current' ? 102 : null,
            sourceRevision: 1,
            createdAt: now,
            updatedAt: now,
          },
        ]).run()
      }
      reportIds.push(previous.id)
    } else {
      const older = db.insert(reports).values({
        title: `${marker} older cycle`,
        content: `# ${marker} older cycle`,
        weekStart: '2027-01-18',
        weekEnd: '2027-01-24',
        createdAt: now,
        updatedAt: now,
      }).returning().get()
      db.insert(reportVariants).values({
        reportId: older.id,
        variant: 'personal' as const,
        sourceDraft: `- ${marker} older source`,
        finalContent: `## 下周计划\n- ${marker} must not backfill`,
        finalStatus: 'current' as const,
        sourceRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).run()
      reportIds.push(older.id)
    }
    const event = db.insert(rawEvents).values({
      eventTime: new Date(`${targetWeekStart}T12:00:00.000Z`),
      source: 'e2e',
      content: `${marker} current source fact`,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    eventIds.push(event.id)
    const target = db.insert(reports).values({
      title: `${marker} target report`,
      content: `# ${marker} target report`,
      weekStart: targetWeekStart,
      weekEnd: targetWeekEnd,
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values([
    ]).run()
    reportIds.push(target.id)
    return NextResponse.json({ targetReportId: target.id, reportIds, eventIds }, { status: 201 })
  }
  if (body.action === 'timeline') {
    const currentWeekStart = startOfWeek(now, { weekStartsOn: 1 })
    const previousWeekEnd = subDays(currentWeekStart, 1)
    const previousWeekStart = subDays(currentWeekStart, 7)
    const weekStart = format(previousWeekStart, 'yyyy-MM-dd')
    const weekEnd = format(previousWeekEnd, 'yyyy-MM-dd')
    const report = db.insert(reports).values({
      title: `${marker} timeline history`,
      content: `# ${marker} timeline history`,
      weekStart,
      weekEnd,
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values([
      {
        reportId: report.id,
        variant: 'leadership' as const,
        sourceDraft: `- ${marker} leadership source`,
        finalContent: `## 下周计划\n- ${marker} leadership plan\n## 下周计划\n- ${marker} ignored duplicate`,
        finalStatus: 'current' as const,
        acceptedProposalId: report.id * 100 + 1,
        sourceRevision: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        reportId: report.id,
        variant: 'personal' as const,
        sourceDraft: `- ${marker} personal source`,
        finalContent: `## 下周计划\n- ${marker} personal plan`,
        finalStatus: 'current' as const,
        acceptedProposalId: report.id * 100 + 2,
        sourceRevision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]).run()
    rows.push({ id: report.id, kind: 'current' })

    const staleReport = db.insert(reports).values({
      title: `${marker} stale timeline history`,
      content: `# ${marker} stale timeline history`,
      weekStart,
      weekEnd,
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values(['leadership', 'personal'].map((variant) => ({
      reportId: staleReport.id,
      variant: variant as 'leadership' | 'personal',
      sourceDraft: `- ${marker} stale source`,
      finalContent: `## 下周计划\n- ${marker} stale excluded`,
      finalStatus: 'stale' as const,
      sourceRevision: 1,
      createdAt: now,
      updatedAt: now,
    }))).run()
    rows.push({ id: staleReport.id, kind: 'stale' })

    const legacyReport = db.insert(reports).values({
      title: `${marker} legacy timeline history`,
      content: `## 下周计划\n- ${marker} legacy excluded`,
      weekStart: format(subDays(previousWeekStart, 7), 'yyyy-MM-dd'),
      weekEnd: format(subDays(previousWeekStart, 1), 'yyyy-MM-dd'),
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    rows.push({ id: legacyReport.id, kind: 'legacy' })
    return NextResponse.json({ reports: rows }, { status: 201 })
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
