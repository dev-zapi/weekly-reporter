import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './generation-fixtures'
import { scriptedInstruction } from './scripted-ai'

interface QueryFixture {
  reportIds: number[]
  adjacentReportId?: number
  sameAudienceReportId: number
  crossAudienceReportId: number
  currentLegacyReportId: number
  staleReportId: number
  legacyReportId: number
  longReportId: number
  noneReportId: number
  unacceptedReportId: number
}

interface ToolMessage {
  partType: string
  content: string | null
  data: {
    toolName?: string
    input?: Record<string, unknown>
    output?: {
      ok: boolean
      items: Array<Record<string, unknown>>
      nextCursor: string | null
      hasMore: boolean
      appliedFilters: Record<string, unknown>
    }
  } | null
}

async function seedQueryFixture(
  request: APIRequestContext,
  marker: string,
  targetReportId: number,
  mode: 'standard' | 'no-adjacent' = 'standard',
): Promise<QueryFixture> {
  const response = await request.post('/api/e2e/fixtures', {
    data: { action: 'report-query', marker, targetReportId, mode },
  })
  expect(response.status()).toBe(201)
  return response.json()
}

async function withQueryFixture<T>(
  request: APIRequestContext,
  marker: string,
  targetReportId: number,
  callback: (fixture: QueryFixture) => Promise<T>,
  mode: 'standard' | 'no-adjacent' = 'standard',
): Promise<T> {
  const fixture = await seedQueryFixture(request, marker, targetReportId, mode)
  try {
    return await callback(fixture)
  } finally {
    const cleanup = await request.delete('/api/e2e/fixtures', { data: { reportIds: fixture.reportIds } })
    expect(cleanup.ok()).toBeTruthy()
  }
}

async function openSessionWithScript(
  page: Page,
  reportId: number,
  instruction: string,
  variant: 'personal' | 'leadership' = 'personal',
) {
  await page.goto(`/edit/${reportId}`)
  if (variant === 'leadership') await page.getByRole('button', { name: 'Leadership' }).click()
  await page.getByRole('button', { name: 'AI chat' }).click()
  await page.getByLabel('Template').selectOption('official-general')
  await page.getByLabel('Initial instruction (editable)').fill(instruction)
  await page.getByRole('button', { name: 'Create session and send' }).click()
}

async function latestSessionDetail(
  request: APIRequestContext,
  reportId: number,
  variant: 'personal' | 'leadership' = 'personal',
) {
  const sessionsResponse = await request.get(`/api/reports/${reportId}/generation-sessions?variant=${variant}`)
  expect(sessionsResponse.ok()).toBeTruthy()
  const sessions = (await sessionsResponse.json()).sessions as Array<{ id: number }>
  expect(sessions).toHaveLength(1)
  const detailResponse = await request.get(`/api/reports/${reportId}/generation-sessions/${sessions[0].id}`)
  expect(detailResponse.ok()).toBeTruthy()
  return detailResponse.json() as Promise<{ messages: ToolMessage[] }>
}

test.describe('AI 查询周报列表', () => {
  test('显式授权 stale 与 legacy 仅返回个人版并展示警示', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      await openSessionWithScript(page, reportId, scriptedInstruction('显式读取过期与旧版历史', {
        steps: [{ kind: 'stream', toolCalls: [{ name: 'query_report_list', arguments: { statuses: ['current', 'stale'], includeLegacy: true } }] }, { kind: 'stream', text: '已带警示读取历史参考。' }],
      }))
      await expect(page.getByText('已带警示读取历史参考。')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('过期终版尚未反映最新周报原稿。').last()).toBeVisible()
      await expect(page.getByText('旧版周报没有周报原稿和受众生成记录，仅供个人版历史参考。').last()).toBeVisible()
      const detail = await latestSessionDetail(request, reportId)
      const output = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list')?.data?.output
      expect(output?.ok).toBe(true)
      expect(output?.appliedFilters).toMatchObject({ statuses: ['current', 'stale'], includeLegacy: true })
      const items = output?.items ?? []
      expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ reportId: fixture.staleReportId, finalStatus: 'stale', warning: expect.stringContaining('过期') }), expect.objectContaining({ reportId: fixture.legacyReportId, isLegacy: true, warning: expect.stringContaining('旧版') })]))
      expect(JSON.stringify(output)).not.toContain('leadership secret')
    })
  })

  test('领导版拒绝 stale/legacy/none/未采用预览与跨受众内容且不泄露正文', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      await openSessionWithScript(page, reportId, scriptedInstruction('验证领导版历史授权边界', {
        steps: [{ kind: 'stream', toolCalls: [
          { name: 'query_report_content', arguments: { reportId: fixture.staleReportId } },
          { name: 'query_report_content', arguments: { reportId: fixture.legacyReportId, allowLegacy: true } },
          { name: 'query_report_content', arguments: { reportId: fixture.noneReportId, allowStale: true } },
          { name: 'query_report_content', arguments: { reportId: fixture.unacceptedReportId, allowStale: true } },
          { name: 'query_report_content', arguments: { reportId: fixture.sameAudienceReportId, allowLegacy: true } },
        ] }, { kind: 'stream', text: '领导版授权边界已验证。' }],
      }), 'leadership')
      await expect(page.getByText('领导版授权边界已验证。')).toBeVisible({ timeout: 30_000 })
      const detail = await latestSessionDetail(request, reportId, 'leadership')
      const results = detail.messages.filter((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_content').map((part) => part.data?.output)
      expect(results).toHaveLength(5)
      for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
      expect(JSON.stringify(results)).not.toContain('secret')
    })
  })

  test('默认查询只返回同受众已采用 current 终版并持久化公开审计', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      await openSessionWithScript(page, reportId, scriptedInstruction('查询可用历史周报列表', {
        steps: [
          {
            kind: 'stream',
            text: '我先查询同受众历史周报。',
            toolCalls: [{ name: 'query_report_list', arguments: {} }],
          },
          { kind: 'stream', text: '已查到同受众历史参考。' },
        ],
      }))

      await expect(page.getByText('已查到同受众历史参考。')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('历史参考·不可信', { exact: true }).last()).toBeVisible()
      await expect(page.getByText(new RegExp(`${scenario} previous adjacent`)).last()).toBeVisible()
      await expect(page.getByText(new RegExp(`${scenario} personal history`)).last()).toBeVisible()
      await expect(page.getByText(new RegExp(`${scenario} leadership only`))).not.toBeVisible()

      const detail = await latestSessionDetail(request, reportId)
      const call = detail.messages.find((part) => part.partType === 'tool-call' && part.data?.toolName === 'query_report_list')
      const result = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list')
      expect(call?.data?.input).toEqual({})
      expect(result?.data?.output?.ok).toBe(true)
      expect(result?.data?.output?.appliedFilters).toEqual({
        query: null,
        title: null,
        startDate: null,
        endDate: null,
        statuses: ['current'],
        includeLegacy: false,
        relation: 'overlap',
        relativeToReportId: null,
        cursor: null,
        limit: 10,
      })
      const items = result?.data?.output?.items ?? []
      expect(items.map((item) => item.reportId)).toEqual(expect.arrayContaining([
        fixture.adjacentReportId,
        fixture.sameAudienceReportId,
      ]))
      expect(items.map((item) => item.reportId)).not.toContain(fixture.crossAudienceReportId)
      expect(items.map((item) => item.reportId)).not.toContain(fixture.currentLegacyReportId)
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([
          'audience',
          'contentAvailable',
          'finalStatus',
          'isLegacy',
          'reportId',
          'title',
          'updatedAt',
          'weekEnd',
          'weekStart',
        ])
        expect(item.audience).toBe('personal')
        expect(item.finalStatus).toBe('current')
        expect(item.isLegacy).toBe(false)
      }
      expect(JSON.stringify(result?.data?.output)).not.toContain('sourceDraft')
      expect(JSON.stringify(result?.data?.output)).not.toContain('suggestions')
      expect(JSON.stringify(result?.data?.output)).not.toContain('scoreOverall')

      await page.reload()
      await page.getByRole('button', { name: 'AI chat' }).click()
      await expect(page.getByText('历史参考·不可信', { exact: true }).last()).toBeVisible()
      await expect(page.getByText(new RegExp(`${scenario} previous adjacent`)).last()).toBeVisible()
    })
  })

  test('previous_adjacent 只返回会话周报的精确上一周期且不分页', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      await openSessionWithScript(page, reportId, scriptedInstruction('查询精确上一周期', {
        steps: [
          {
            kind: 'stream',
            toolCalls: [{
              name: 'query_report_list',
              arguments: {
                relation: 'previous_adjacent',
                relativeToReportId: reportId,
                query: 'ignored query',
                startDate: '1900-01-01',
                endDate: '1900-01-02',
                cursor: 'ignored cursor',
                limit: 20,
              },
            }],
          },
          { kind: 'stream', text: '精确上一周期查询完成。' },
        ],
      }))

      await expect(page.getByText('精确上一周期查询完成。')).toBeVisible({ timeout: 30_000 })
      const detail = await latestSessionDetail(request, reportId)
      const output = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list')?.data?.output
      expect(output?.ok).toBe(true)
      expect(output?.items.map((item) => item.reportId)).toEqual([fixture.adjacentReportId])
      expect(output?.hasMore).toBe(false)
      expect(output?.nextCursor).toBeNull()
      expect(output?.appliedFilters).toMatchObject({
        query: null,
        startDate: null,
        endDate: null,
        relation: 'previous_adjacent',
        relativeToReportId: reportId,
        cursor: null,
        limit: 1,
      })
    })
  })

  test('previous_adjacent 无精确来源时成功返回空列表且不回退', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async () => {
      await openSessionWithScript(page, reportId, scriptedInstruction('查询不存在的精确上一周期', {
        steps: [
          {
            kind: 'stream',
            toolCalls: [{
              name: 'query_report_list',
              arguments: { relation: 'previous_adjacent', relativeToReportId: reportId },
            }],
          },
          { kind: 'stream', text: '没有精确上一周期，继续仅依据本周原稿。' },
        ],
      }))

      await expect(page.getByText('没有精确上一周期，继续仅依据本周原稿。')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('未找到符合条件的历史周报', { exact: true })).toBeVisible()
      const detail = await latestSessionDetail(request, reportId)
      const output = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list')?.data?.output
      expect(output).toMatchObject({ ok: true, items: [], nextCursor: null, hasMore: false })
    }, 'no-adjacent')
  })

  test('query 与 title 条件返回正文命中并规范化筛选', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      await openSessionWithScript(page, reportId, scriptedInstruction('按标题和正文查询历史周报', {
        steps: [
          {
            kind: 'stream',
            toolCalls: [{
              name: 'query_report_list',
              arguments: {
                query: scenario,
                title: scenario,
                startDate: '2026-12-01',
                endDate: '2027-01-31',
                statuses: ['current'],
                includeLegacy: false,
                relation: 'overlap',
                limit: 20,
              },
            }],
          },
          { kind: 'stream', text: '已按条件定位历史周报。' },
        ],
      }))

      await expect(page.getByText('已按条件定位历史周报。')).toBeVisible({ timeout: 30_000 })
      const detail = await latestSessionDetail(request, reportId)
      const output = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list')?.data?.output
      expect(output?.ok).toBe(true)
      expect(output?.appliedFilters).toEqual({
        query: scenario,
        title: scenario,
        startDate: '2026-12-01',
        endDate: '2027-01-31',
        statuses: ['current'],
        includeLegacy: false,
        relation: 'overlap',
        relativeToReportId: null,
        cursor: null,
        limit: 20,
      })
      expect(output?.items).toHaveLength(2)
      expect(output?.items.every((item) => Array.isArray(item.matches) && item.matches.length > 0)).toBe(true)
      expect(output?.items.map((item) => item.reportId)).toEqual(expect.arrayContaining([
        fixture.adjacentReportId,
        fixture.sameAudienceReportId,
      ]))
    })
  })

  test('audience 参数被拒绝且不会改变服务端固定受众', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async () => {
      await openSessionWithScript(page, reportId, scriptedInstruction('尝试切换历史查询受众', {
        steps: [
          {
            kind: 'stream',
            toolCalls: [{ name: 'query_report_list', arguments: { audience: 'leadership' } }],
          },
          { kind: 'stream', text: '受众仍由服务端固定，未执行跨受众查询。' },
        ],
      }))

      await expect(page.getByText('受众仍由服务端固定，未执行跨受众查询。')).toBeVisible({ timeout: 30_000 })
      const detail = await latestSessionDetail(request, reportId)
      const result = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list')
      expect(result?.data?.output).toMatchObject({
        ok: false,
        error: { code: 'INVALID_QUERY' },
      })
      expect(JSON.stringify(result?.data?.output)).not.toContain('leadership only')
    })
  })
})

test.describe('AI 查询周报内容', () => {
  test('列表后读取同受众正文、grep、截断、空结果与公开审计', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      await openSessionWithScript(page, reportId, scriptedInstruction('读取历史周报内容', {
        steps: [{ kind: 'stream', toolCalls: [
          { name: 'query_report_content', arguments: { reportId: fixture.sameAudienceReportId, query: 'searchable', maxMatches: 5, contextLines: 1 } },
          { name: 'query_report_content', arguments: { reportId: fixture.longReportId } },
        ] }, { kind: 'stream', text: '内容查询完成。' }],
      }))
      await expect(page.getByText('内容查询完成。')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('查询周报内容').last()).toBeVisible()
      const detail = await latestSessionDetail(request, reportId)
      const result = detail.messages.find((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_content')
      expect(result?.data?.output).toMatchObject({ ok: true, found: true, query: 'searchable', totalMatches: 1, returnedMatches: 1, truncated: false })
      const fullResult = detail.messages.filter((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_content').at(-1)?.data?.output
      expect(fullResult).toMatchObject({ ok: true, found: true, truncated: true })
      const fullResultObj = fullResult as unknown as { totalChars: number; returnedChars: number }
      expect(fullResultObj.totalChars).toBeGreaterThan(40_000)
      expect(fullResultObj.returnedChars).toBeLessThanOrEqual(40_000)
      expect(JSON.stringify(result?.data?.output)).toContain('历史参考·不可信')
    })
  })

  test('重新授权拒绝 stale/legacy 默认访问并允许显式授权，空结果成功', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async (fixture) => {
      // 脚本步进按「用户轮次数 + 工具调用消息数」定位，而跨轮重建的历史只保留
      // 文本 part（transcriptToModelMessages 丢弃 tool-call/tool-result，工具
      // 输出不进上下文预算）——所以：第一轮消费 step0（5 次查询，单轮内容查询
      // 预算 MAX_CONTENT_QUERIES_PER_TURN=5）+ step1（收尾文本）；第二轮的请求
      // 重建后仍定位到 step1（重放同一段文本）；第三轮才消费 step2/step3，
      // 让「不存在的周报」作为新预算周期里的第 6 次查询。
      await openSessionWithScript(page, reportId, scriptedInstruction('检查内容授权', {
        steps: [
          { kind: 'stream', toolCalls: [
            { name: 'query_report_content', arguments: { reportId: fixture.staleReportId } },
            { name: 'query_report_content', arguments: { reportId: fixture.staleReportId, allowStale: true } },
            { name: 'query_report_content', arguments: { reportId: fixture.legacyReportId } },
            { name: 'query_report_content', arguments: { reportId: fixture.legacyReportId, allowLegacy: true } },
            { name: 'query_report_content', arguments: { reportId: fixture.crossAudienceReportId, allowLegacy: true } },
          ] },
          { kind: 'stream', text: '授权检查完成。' },
          { kind: 'stream', toolCalls: [{ name: 'query_report_content', arguments: { reportId: 999999999, query: 'missing' } }] },
          { kind: 'stream', text: '空结果检查完成。' },
        ],
      }))
      await expect(page.getByText('授权检查完成。')).toBeVisible({ timeout: 30_000 })

      const composer = page.getByPlaceholder('Ask AI to revise, answer a question, or submit the current version...')
      await composer.fill('继续检查一个不存在的周报')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      // 第二轮重放 step1 的文本——用出现次数同步「第二轮已完成」
      await expect(page.getByText('授权检查完成。')).toHaveCount(2, { timeout: 30_000 })

      await composer.fill('最后检查一个不存在的周报')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(page.getByText('空结果检查完成。')).toBeVisible({ timeout: 30_000 })

      const detail = await latestSessionDetail(request, reportId)
      const results = detail.messages.filter((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_content').map((part) => part.data?.output)
      expect(results).toHaveLength(6)
      expect(results[0]).toMatchObject({ ok: true, found: false })
      expect(results[1]).toMatchObject({ ok: true, found: true, identity: { finalStatus: 'stale' } })
      expect(results[2]).toMatchObject({ ok: true, found: false })
      expect(results[3]).toMatchObject({ ok: true, found: true, identity: { isLegacy: true } })
      expect(results[4]).toMatchObject({ ok: true, found: false })
      expect(results[5]).toMatchObject({ ok: true, found: false })
    })
  })
})

test.describe('AI 查询周报预算与失败恢复', () => {
  test('限制单轮历史查询调用次数并保留可继续生成的工具结果', async ({ page, request, reportId, scenario }) => {
    await withQueryFixture(request, scenario, reportId, async () => {
      const toolCalls = Array.from({ length: 11 }, () => ({ name: 'query_report_list', arguments: {} }))
      await openSessionWithScript(page, reportId, scriptedInstruction('验证历史查询调用预算', {
        steps: [{ kind: 'stream', toolCalls }, { kind: 'stream', text: '预算耗尽后仍可继续生成。' }],
      }))
      await expect(page.getByText('预算耗尽后仍可继续生成。')).toBeVisible({ timeout: 30_000 })
      const detail = await latestSessionDetail(request, reportId)
      const results = detail.messages.filter((part) => part.partType === 'tool-result' && part.data?.toolName === 'query_report_list').map((part) => part.data?.output)
      expect(results).toHaveLength(11)
      expect(results.at(-1)).toMatchObject({ ok: false, error: { code: 'TOOL_BUDGET_EXCEEDED' } })
    })
  })
})
