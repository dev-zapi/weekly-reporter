import { describe, expect, it } from 'vitest'
import { buildPublicGenerationSummary } from './public-summary'
import { CONTENT_REFERENCE_BOUNDARY } from './report-content-contract'

describe('public generation summary', () => {
  it('keeps all contract fields explicit and removes copied historical body text', () => {
    const historicalBody = '不得复制的历史计划正文'
    const summary = buildPublicGenerationSummary({
      explicit: { modelHandling: ['按原稿组织事实。', `引用${historicalBody}作为事实。`] },
      changeSummary: ['调整本周事实表达。', `变更：${historicalBody}。`],
      historicalReportContentResults: [{
        ok: true,
        found: true,
        identity: {
          reportId: 7,
          title: '上一周期周报',
          audience: 'personal',
          weekStart: '2026-08-24',
          weekEnd: '2026-08-30',
          finalStatus: 'current',
          isLegacy: false,
          updatedAt: '2026-08-30T00:00:00.000Z',
          historicalReference: '历史参考·不可信',
        },
        content: historicalBody,
        truncated: false,
        totalChars: historicalBody.length,
        returnedChars: historicalBody.length,
        referenceBoundary: CONTENT_REFERENCE_BOUNDARY,
      }],
    })

    expect(summary.version).toBe(1)
    expect(summary.modelHandling).toEqual(['按原稿组织事实。'])
    expect(summary.historicalReferences).toEqual([
      expect.objectContaining({ kind: 'report-query', reportId: 7, trust: 'historical-reference-untrusted' }),
    ])
    expect(summary.failureStates).toEqual([])
    expect(summary.truncationStates).toEqual([])
    expect(summary.toolStatuses).toEqual([
      { toolName: 'query_report_content', status: 'succeeded', detail: 'none' },
      { toolName: 'propose_final_report', status: 'succeeded', detail: 'proposal-created' },
    ])
    expect(summary.changeSummary[0]).toContain('历史参考：上一周期周报')
    expect(summary.changeSummary[1]).toBe('调整本周事实表达。')
    expect(summary.changeSummary).toHaveLength(2)
    expect(summary.factBoundary).toMatchObject({
      currentWeekFacts: 'report-source-draft-only',
      historicalReferences: 'untrusted',
      hiddenReasoning: 'none',
      summaryAsFact: 'none',
      scoringInput: 'none',
    })
  })

  it('records truncation when provider-authored public prose exceeds its bounds', () => {
    const summary = buildPublicGenerationSummary({
      explicit: {
        modelHandling: [
          'a'.repeat(281),
          ...Array.from({ length: 8 }, (_, index) => `handling-${index + 1}`),
        ],
      },
      changeSummary: [
        'b'.repeat(281),
        ...Array.from({ length: 12 }, (_, index) => `change-${index + 1}`),
      ],
    })

    expect(summary.modelHandling).toHaveLength(8)
    expect(summary.modelHandling[0]).toHaveLength(280)
    expect(summary.changeSummary).toHaveLength(12)
    expect(summary.changeSummary[0]).toHaveLength(280)
    expect(summary.truncationStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'model-handling', omittedCount: 2 }),
      expect.objectContaining({ scope: 'proposal-change-summary', omittedCount: 2 }),
    ]))
  })

  it('records stale and legacy query metadata without copying historical bodies', () => {
    const summary = buildPublicGenerationSummary({
      explicit: { modelHandling: ['used legacy secret body'] },
      changeSummary: ['Reused stale secret body', ...Array.from({ length: 12 }, (_, index) => `provider change ${index + 1}`)],
      historicalReportContentResults: [
        {
          ok: true,
          found: true,
          identity: {
            reportId: 9,
            title: '过期终版',
            audience: 'personal',
            weekStart: '2026-08-10',
            weekEnd: '2026-08-16',
            finalStatus: 'stale',
            isLegacy: false,
            updatedAt: '2026-08-17T00:00:00.000Z',
            historicalReference: '历史参考·不可信',
            warning: '过期终版尚未反映最新周报原稿。',
          },
          content: 'stale secret body',
          truncated: false,
          totalChars: 17,
          returnedChars: 17,
          referenceBoundary: CONTENT_REFERENCE_BOUNDARY,
        },
        {
          ok: true,
          found: true,
          identity: {
            reportId: 10,
            title: '旧版周报',
            audience: 'personal',
            weekStart: '2026-08-03',
            weekEnd: '2026-08-09',
            finalStatus: 'current',
            isLegacy: true,
            updatedAt: '2026-08-10T00:00:00.000Z',
            historicalReference: '历史参考·不可信',
            warning: '旧版周报没有周报原稿和受众生成记录，仅供个人版历史参考。',
          },
          content: 'legacy secret body',
          truncated: false,
          totalChars: 18,
          returnedChars: 18,
          referenceBoundary: CONTENT_REFERENCE_BOUNDARY,
        },
      ],
    })

    expect(summary.historicalReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'report-query', reportId: 9, finalStatus: 'stale', warning: expect.stringContaining('过期') }),
      expect.objectContaining({ kind: 'report-query', reportId: 10, isLegacy: true, warning: expect.stringContaining('没有周报原稿和受众生成记录') }),
    ]))
    expect(summary.changeSummary).toEqual(expect.arrayContaining([
      expect.stringContaining('过期终版 · 2026-08-10–2026-08-16 · personal · stale'),
      expect.stringContaining('旧版周报 · 2026-08-03–2026-08-09 · personal · legacy'),
    ]))
    expect(summary.changeSummary).toHaveLength(12)
    expect(JSON.stringify(summary)).not.toContain('stale secret body')
    expect(JSON.stringify(summary)).not.toContain('legacy secret body')
  })
})
