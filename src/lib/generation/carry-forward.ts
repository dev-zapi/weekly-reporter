import { createHash } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { format, parseISO, subDays } from 'date-fns'
import { getDb } from '@/lib/db'
import { reportVariants, reports, type AudienceVariant, type Report } from '@/lib/db/schema'
import { parseNextWeekPlan, type NextWeekPlanParseResult } from '@/lib/reports/next-week-plan'
import type { CarryForwardSnapshot } from './carry-forward-snapshot'

export {
  LEGACY_NO_SNAPSHOT,
  LEGACY_NO_SNAPSHOT_REASON,
  normalizeCarryForwardSnapshot,
  serializeCarryForwardSnapshot,
} from './carry-forward-snapshot'
export type { CarryForwardCandidate, CarryForwardJudgment, CarryForwardSnapshot } from './carry-forward-snapshot'

function normalizedPlanText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function candidateId(text: string, occurrence: number): string {
  const digest = createHash('sha256').update(`${normalizedPlanText(text)}\u0000${occurrence}`).digest('hex').slice(0, 20)
  return `carry-forward-${digest}`
}

function sourceMetadata(report: Report, variant: NonNullable<typeof reportVariants.$inferSelect>): CarryForwardSnapshot['source'] {
  return {
    reportId: report.id,
    title: report.title,
    audience: variant.variant,
    weekStart: report.weekStart,
    weekEnd: report.weekEnd,
    finalStatus: 'current',
    acceptedProposalId: variant.acceptedProposalId ?? null,
    updatedAt: variant.updatedAt.toISOString(),
  }
}

function snapshotFromParse(
  report: Report,
  variant: NonNullable<typeof reportVariants.$inferSelect>,
  parsed: NextWeekPlanParseResult,
  capturedAt: Date,
): CarryForwardSnapshot {
  const source = sourceMetadata(report, variant)
  if (parsed.status === 'found') {
    const occurrences = new Map<string, number>()
    const candidates = parsed.items.map((text) => {
      const normalized = normalizedPlanText(text)
      const occurrence = occurrences.get(normalized) ?? 0
      occurrences.set(normalized, occurrence + 1)
      return {
        candidateId: candidateId(text, occurrence),
        text,
        normalizedText: normalized,
        source: 'carry-forward' as const,
        judgment: null,
        reason: null,
      }
    })
    return {
      version: 1,
      status: 'found',
      reason: null,
      capturedAt: capturedAt.toISOString(),
      source,
      planText: parsed.rawText,
      parseStatus: parsed.status,
      parseReason: null,
      parseWarning: parsed.warning ?? null,
      candidates,
    }
  }

  const status = parsed.status === 'failed' ? 'parse-failed' : 'no-plan'
  return {
    version: 1,
    status,
    reason: parsed.reason,
    capturedAt: capturedAt.toISOString(),
    source,
    planText: parsed.status === 'missing' ? null : parsed.rawText,
    parseStatus: parsed.status,
    parseReason: parsed.reason,
    parseWarning: null,
    candidates: [],
  }
}

function noSourceSnapshot(audience: AudienceVariant, capturedAt: Date): CarryForwardSnapshot {
  return {
    version: 1,
    status: 'no-source',
    reason: `No exact previous-cycle current final report is available for the ${audience} audience.`,
    capturedAt: capturedAt.toISOString(),
    source: null,
    planText: null,
    parseStatus: 'missing',
    parseReason: 'No exact source was available to parse.',
    parseWarning: null,
    candidates: [],
  }
}

/**
 * Capture the exact adjacent cycle's same-audience current final. This is a
 * read-only lookup; callers persist the returned value as the session's copy.
 */
export async function createCarryForwardSnapshot(report: Report, audience: AudienceVariant, capturedAt = new Date()): Promise<CarryForwardSnapshot> {
  const weekStart = parseISO(report.weekStart)
  const previousWeekEnd = format(subDays(weekStart, 1), 'yyyy-MM-dd')
  const previousWeekStart = format(subDays(weekStart, 7), 'yyyy-MM-dd')
  const db = getDb()
  const candidateReports = await db.select().from(reports)
    .where(and(eq(reports.weekStart, previousWeekStart), eq(reports.weekEnd, previousWeekEnd)))
    .orderBy(desc(reports.updatedAt), desc(reports.id))
  if (candidateReports.length === 0) return noSourceSnapshot(audience, capturedAt)

  const candidateVariants = await db.select().from(reportVariants)
    .where(inArray(reportVariants.reportId, candidateReports.map((item) => item.id)))
  for (const candidateReport of candidateReports) {
    const candidate = candidateVariants.find((item) => item.reportId === candidateReport.id && item.variant === audience)
    if (!candidate || candidate.finalStatus !== 'current' || !candidate.finalContent?.trim()) continue
    return snapshotFromParse(candidateReport, candidate, parseNextWeekPlan(candidate.finalContent), capturedAt)
  }
  return noSourceSnapshot(audience, capturedAt)
}
