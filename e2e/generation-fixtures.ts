/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture callbacks are not React hooks. */
import { expect, test as base } from './app-fixture'
import { SCRIPTED_AI_URL } from './scripted-ai'

type Fixtures = { reportId: number; scenario: string; weekStart: string; weekEnd: string }

function scenarioWeek(scenario: string): { weekStart: string; weekEnd: string } {
  let hash = 0
  for (const character of scenario) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  const day = 1 + (hash % 20)
  return { weekStart: `2027-01-${String(day).padStart(2, '0')}`, weekEnd: `2027-01-${String(day + 6).padStart(2, '0')}` }
}

export const test = base.extend<Fixtures & { generousTimeout: void }>({
  /**
   * 自动放宽用例超时（30s → 90s）：走 worker app 夹具的用例都是「创建会话 →
   * 多轮流式往返 → 采用/重载」的重流程，dev 模式下还可能吃到路由冷编译
   * （app-fixture 已预热，这里再留余量）。放在共享 fixture 而不是各 spec 的
   * beforeEach 里重复。
   */
  generousTimeout: [async ({}, use, testInfo) => {
    testInfo.setTimeout(90_000)
    await use()
  }, { auto: true }],
  scenario: async ({}, use, testInfo) => {
    await use(`e2e-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.testId}`)
  },
  weekStart: async ({ scenario }, use) => { await use(scenarioWeek(scenario).weekStart) },
  weekEnd: async ({ scenario }, use) => { await use(scenarioWeek(scenario).weekEnd) },
  reportId: async ({ request, scenario, weekStart, weekEnd }, use) => {
    let eventId: number | undefined
    let reportId: number | undefined
    try {
      const config = await request.put('/api/settings/ai', {
        data: { protocol: 'openai-compatible', apiUrl: SCRIPTED_AI_URL, apiKey: 'e2e-scripted', model: 'e2e-scripted' },
      })
      expect(config.ok()).toBeTruthy()
      const event = await request.post('/api/events', { data: { content: `${scenario}: completed deterministic work`, eventTime: `${weekStart}T12:00:00.000Z` } })
      expect(event.ok()).toBeTruthy()
      eventId = ((await event.json()) as { id: number }).id
      const report = await request.post('/api/reports', { data: { title: `${scenario} report`, weekStart, weekEnd } })
      expect(report.ok()).toBeTruthy()
      reportId = ((await report.json()) as { report: { id: number } }).report.id
      await use(reportId)
    } finally {
      if (reportId || eventId) {
        const cleanup = await request.delete('/api/e2e/fixtures', {
          data: { reportIds: reportId ? [reportId] : [], eventIds: eventId ? [eventId] : [] },
        })
        expect(cleanup.ok()).toBeTruthy()
      }
    }
  },
})

export { expect }
