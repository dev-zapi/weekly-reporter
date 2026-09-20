import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { generationSessions, reportVariants, reports } from '@/lib/db/schema'
import {
  CONTENT_REFERENCE_BOUNDARY,
  REPORT_CONTENT_TOOL_NAME,
  type ReportContentToolInput,
  type ReportContentToolResult,
} from './report-content-contract'

export { CONTENT_REFERENCE_BOUNDARY, REPORT_CONTENT_TOOL_NAME }
export type { ReportContentToolInput, ReportContentToolResult }

const MAX_CONTENT_CHARS = 40_000
const MAX_QUERY_CHARS = 200

function invalid(message: string): ReportContentToolResult {
  return { ok: false, error: { code: 'INVALID_QUERY', message }, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
}

function literalMatches(content: string, query: string, contextLines: number, maxMatches: number) {
  const lines = content.split('\n')
  const needle = query.toLocaleLowerCase()
  const matchingLines = lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index] : [])
  const ranges: Array<{ start: number; end: number }> = []
  for (const line of matchingLines) {
    const next = { start: Math.max(0, line - contextLines), end: Math.min(lines.length - 1, line + contextLines) }
    const previous = ranges.at(-1)
    if (previous && next.start <= previous.end + 1) previous.end = Math.max(previous.end, next.end)
    else ranges.push(next)
  }
  return { total: matchingLines.length, ranges: ranges.slice(0, maxMatches).map((range) => ({ startLine: range.start + 1, endLine: range.end + 1, content: lines.slice(range.start, range.end + 1).join('\n') })) }
}

export function queryReportContentForSession(input: { sessionId: number; parameters: ReportContentToolInput }): ReportContentToolResult {
  try {
    const params = input.parameters
    if (!Number.isInteger(params.reportId) || Number(params.reportId) <= 0) return invalid('reportId must be a positive integer')
    const reportId = Number(params.reportId)
    const query = params.query?.trim()
    if (params.query !== undefined && (!query || query.length > MAX_QUERY_CHARS)) return invalid('query must contain 1 to 200 characters after trimming')
    const requestedMaxMatches = params.maxMatches ?? 5
    const contextLines = params.contextLines ?? 1
    if (!Number.isInteger(requestedMaxMatches) || requestedMaxMatches < 1 || requestedMaxMatches > 10) return invalid('maxMatches must be an integer from 1 to 10')
    const maxMatches = requestedMaxMatches
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 5) return invalid('contextLines must be an integer from 0 to 5')
    const db = getDb()
    const session = db.select({ reportId: generationSessions.reportId, audience: generationSessions.variant }).from(generationSessions).where(eq(generationSessions.id, input.sessionId)).get()
    if (!session) return { ok: false, error: { code: 'QUERY_FAILED', message: 'Generation session is unavailable' }, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
    const report = db.select().from(reports).where(eq(reports.id, reportId)).get()
    if (!report) return { ok: true, found: false, reportId, truncated: false, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
    const variant = db.select().from(reportVariants).where(and(eq(reportVariants.reportId, reportId), eq(reportVariants.variant, session.audience))).get()
    const hasModernVariant = Boolean(db.select({ id: reportVariants.id }).from(reportVariants).where(eq(reportVariants.reportId, reportId)).get())
    const isLegacy = !hasModernVariant
    const unavailable = (message: string): ReportContentToolResult => session.audience === 'leadership'
      ? { ok: false, error: { code: 'NOT_AVAILABLE', message }, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
      : { ok: true, found: false, reportId, truncated: false, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
    if (!variant) {
      if (!isLegacy || session.audience !== 'personal' || params.allowLegacy !== true) {
        return unavailable('This historical report is not available for the current audience or authorization')
      }
    } else {
      if (variant.finalStatus === 'none' || !variant.finalContent) {
        return unavailable('The requested report has no current final for this audience')
      }
      if (variant.finalStatus === 'stale' && params.allowStale !== true) {
        return unavailable('The stale final requires explicit authorization')
      }
    }
    const status = variant?.finalStatus ?? 'current'
    const content = variant?.finalContent ?? report.content
    const identity = { reportId: report.id, title: report.title, weekStart: report.weekStart, weekEnd: report.weekEnd, audience: session.audience, finalStatus: status, isLegacy, updatedAt: (variant?.updatedAt ?? report.updatedAt).toISOString(), historicalReference: CONTENT_REFERENCE_BOUNDARY.label, warning: isLegacy ? '旧版周报没有周报原稿和受众生成记录，仅供个人版历史参考。' : status === 'stale' ? '过期终版尚未反映最新周报原稿。' : undefined } as const
    if (!query) {
      const truncated = content.length > MAX_CONTENT_CHARS
      const marker = '\n[系统截断：正文超过 40,000 字符]'
      const bounded = truncated ? `${content.slice(0, MAX_CONTENT_CHARS - marker.length)}${marker}` : content
      return { ok: true, found: true, identity, content: bounded, truncated, returnedChars: bounded.length, totalChars: content.length, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
    }
    const matched = literalMatches(content, query, contextLines, maxMatches)
    let budget = MAX_CONTENT_CHARS
    const matches = matched.ranges.flatMap((match) => {
      if (match.content.length > budget) return []
      budget -= match.content.length
      return [match]
    })
    const budgetTruncated = matches.length < matched.ranges.slice(0, maxMatches).length
    return { ok: true, found: true, identity, query, matches, totalMatches: matched.total, returnedMatches: matches.length, truncated: budgetTruncated || matched.total > maxMatches, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
  } catch (error) {
    console.error('[generation] Report content query failed:', error)
    return { ok: false, error: { code: 'QUERY_FAILED', message: 'Failed to query historical report content' }, referenceBoundary: CONTENT_REFERENCE_BOUNDARY }
  }
}
