import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  generationMessageParts,
  generationProposals,
  generationSessions,
  generationTurns,
  reportVariants,
  reports,
} from '@/lib/db/schema'
import {
  acceptGenerationProposal,
  createGenerationProposal,
  createGenerationSession,
  finishGenerationTurn,
  getGenerationSessionDetail,
  startGenerationTurn,
} from './service'

const testConfig = () => {
  const now = new Date()
  return {
    id: 1,
    protocol: 'openai-compatible' as const,
    apiUrl: 'https://example.invalid',
    apiKey: 'test',
    model: 'test-model',
    modelListCache: null,
    modelListCachedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

describe('generation session lifecycle', () => {
  it('snapshots context and only writes the final when a proposal is accepted', async () => {
    const db = getDb()
    const now = new Date()
    const report = db.insert(reports).values({
      title: `generation-test-${Date.now()}`,
      content: '- 完成会话持久化',
      weekStart: '2026-08-10',
      weekEnd: '2026-08-16',
      createdAt: now,
      updatedAt: now,
    }).returning().get()
    const variant = db.insert(reportVariants).values({
      reportId: report.id,
      variant: 'personal',
      sourceDraft: '- **weekly-reporter**\n  - 完成会话持久化',
      sourceRevision: 3,
      finalStatus: 'none',
      createdAt: now,
      updatedAt: now,
    }).returning().get()

    const session = await createGenerationSession({
      reportId: report.id,
      variant: 'personal',
      templateId: 'official-general',
    })
    const detail = await getGenerationSessionDetail(report.id, session.id)
    expect(detail?.messages.map((part) => part.partType)).toEqual([
      'system-prompt',
      'style-prompt',
      'tool-rules',
      'source-overview',
    ])
    expect(detail?.sourceDraftSnapshot).toContain('完成会话持久化')
    expect(db.select().from(generationSessions).where(eq(generationSessions.id, session.id)).get()?.carryForwardSnapshot).toBeNull()
    expect(db.select().from(generationSessions).where(eq(generationSessions.id, session.id)).get()?.planPolicy).toBeNull()

    const turn = startGenerationTurn({
      session,
      config: testConfig(),
      userMessage: '请生成候选终版',
    })
    const firstProposal = await createGenerationProposal({
      session,
      turnId: turn.id,
      content: '# 本周完成\n\n- 完成会话持久化',
      summary: ['按模板归类原稿事实'],
      publicSummary: { modelHandling: ['仅依据个人版周报原稿整理本周事实。'] },
    })
    await finishGenerationTurn(turn.id, 'completed')

    expect(db.select().from(reportVariants).where(eq(reportVariants.id, variant.id)).get()?.finalContent).toBeNull()
    expect(firstProposal.baselineContent).toBe('')
    expect(firstProposal.planState).toBeNull()
    expect(firstProposal.summary).toEqual(['按模板归类原稿事实'])
    expect(firstProposal.publicSummary).toMatchObject({
      version: 1,
      modelHandling: ['仅依据个人版周报原稿整理本周事实。'],
      historicalReferences: [],
      toolStatuses: [{ toolName: 'propose_final_report', status: 'succeeded', detail: 'proposal-created' }],
      truncationStates: [],
      changeSummary: ['按模板归类原稿事实'],
      factBoundary: { currentWeekFacts: 'report-source-draft-only', scoringInput: 'none' },
    })

    const secondTurn = startGenerationTurn({
      session,
      config: testConfig(),
      userMessage: '补充下周重点后重新提交',
    })
    const secondProposal = await createGenerationProposal({
      session,
      turnId: secondTurn.id,
      content: '# 本周完成\n\n- 完成会话持久化\n\n## 下周计划\n\n- 推进下一阶段',
      summary: ['补充下周计划章节'],
    })
    await finishGenerationTurn(secondTurn.id, 'completed')
    expect(db.select().from(generationProposals).where(eq(generationProposals.id, firstProposal.id)).get()?.status).toBe('superseded')
    await expect(acceptGenerationProposal({
      reportId: report.id,
      sessionId: session.id,
      proposalId: firstProposal.id,
    })).rejects.toMatchObject({ code: 'PROPOSAL_SUPERSEDED' })

    const accepted = await acceptGenerationProposal({
      reportId: report.id,
      sessionId: session.id,
      proposalId: secondProposal.id,
    })
    expect(accepted.variant.finalContent).toContain('完成会话持久化')
    expect(accepted.variant.finalContent).toContain('## 下周计划')
    expect(accepted.variant.acceptedProposalId).toBe(secondProposal.id)
    expect(accepted.variant.structureCompletenessRule).toBeNull()
    expect(db.select().from(reports).where(eq(reports.id, report.id)).get()?.content).toContain('完成会话持久化')
    expect(db.select().from(generationMessageParts).where(eq(generationMessageParts.sessionId, session.id)).all().at(-1)?.partType).toBe('proposal-accepted')
    expect(db.select().from(generationSessions).where(eq(generationSessions.id, session.id)).get()?.baselineFinalContent).toBe(secondProposal.content)

    db.delete(generationProposals).where(eq(generationProposals.sessionId, session.id)).run()
    db.delete(generationMessageParts).where(eq(generationMessageParts.sessionId, session.id)).run()
    db.delete(generationTurns).where(eq(generationTurns.sessionId, session.id)).run()
    db.delete(generationSessions).where(eq(generationSessions.id, session.id)).run()
    db.delete(reportVariants).where(eq(reportVariants.reportId, report.id)).run()
    db.delete(reports).where(eq(reports.id, report.id)).run()
  })
})
