import { describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { generationSessions, reportVariants, reports } from '@/lib/db/schema'
import { queryReportContentForSession } from './report-content-tool'

describe('queryReportContentForSession', () => {
  it('returns the final content for a current variant without acceptedProposalId', () => {
    const db = getDb()
    const now = new Date()
    const marker = `report-content-no-proposal-${Date.now()}`
    const report = db.insert(reports).values({
      title: `${marker} report`, content: 'legacy', weekStart: '2027-04-05', weekEnd: '2027-04-11',
      createdAt: now, updatedAt: now,
    }).returning().get()
    const variant = db.insert(reportVariants).values({
      reportId: report.id, variant: 'leadership' as const, sourceDraft: 'source',
      finalContent: `# ${marker}\n\nContent body here`, finalStatus: 'current' as const,
      acceptedProposalId: null, sourceRevision: 1 as const,
      createdAt: now, updatedAt: now,
    }).returning().get()
    const session = db.insert(generationSessions).values({
      reportId: report.id, reportVariantId: variant.id, variant: 'leadership' as const,
      title: 'session', status: 'active' as const, sourceRevision: 1,
      sourceDraftSnapshot: 'source', sourceOverview: 'overview',
      templateId: 'official-general', templateName: '通用', templateContent: 'content',
      aiStyleKey: 'formal', aiStyleLabel: '正式', aiStylePrompt: 'prompt',
      temperature: '0.3', systemPrompt: 'system', toolRules: '{}',
      createdAt: now, updatedAt: now,
    }).returning().get()

    const result = queryReportContentForSession({
      sessionId: session.id,
      parameters: { reportId: report.id },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.found).toBe(true)
      if (result.found) {
        expect(result.content).toContain(marker)
        expect(result.identity.finalStatus).toBe('current')
      }
    }

    db.delete(generationSessions).where(inArray(generationSessions.reportId, [report.id])).run()
    db.delete(reportVariants).where(inArray(reportVariants.reportId, [report.id])).run()
    db.delete(reports).where(inArray(reports.id, [report.id])).run()
  })

  it('still rejects a variant with finalStatus none', () => {
    const db = getDb()
    const now = new Date()
    const marker = `report-content-none-${Date.now()}`
    const report = db.insert(reports).values({
      title: `${marker} report`, content: 'legacy', weekStart: '2027-05-03', weekEnd: '2027-05-09',
      createdAt: now, updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values({
      reportId: report.id, variant: 'leadership' as const, sourceDraft: 'source',
      finalContent: null, finalStatus: 'none' as const,
      acceptedProposalId: null, sourceRevision: 1 as const,
      createdAt: now, updatedAt: now,
    }).run()
    const session = db.insert(generationSessions).values({
      reportId: report.id, reportVariantId: 0, variant: 'leadership' as const,
      title: 'session', status: 'active' as const, sourceRevision: 1,
      sourceDraftSnapshot: 'source', sourceOverview: 'overview',
      templateId: 'official-general', templateName: '通用', templateContent: 'content',
      aiStyleKey: 'formal', aiStyleLabel: '正式', aiStylePrompt: 'prompt',
      temperature: '0.3', systemPrompt: 'system', toolRules: '{}',
      createdAt: now, updatedAt: now,
    }).returning().get()

    const result = queryReportContentForSession({
      sessionId: session.id,
      parameters: { reportId: report.id },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_AVAILABLE')
    }

    db.delete(generationSessions).where(inArray(generationSessions.reportId, [report.id])).run()
    db.delete(reportVariants).where(inArray(reportVariants.reportId, [report.id])).run()
    db.delete(reports).where(inArray(reports.id, [report.id])).run()
  })
})
