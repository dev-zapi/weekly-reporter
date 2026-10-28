import { test, expect } from './generation-fixtures'
import { disposeHistoricalReports, seedHistoricalReports } from './historical-fixtures'
import { scriptedInstruction } from './scripted-ai'

const acceptedContent = '# 本周完成\n\n- 完成确定性 E2E 验收\n\n## 下周计划\n\n- 保持验收夹具稳定'

function proposalStep(content = acceptedContent) {
  return {
    kind: 'stream' as const,
    reasoning: '已核对原稿事实。',
    text: '已准备候选终版。',
    toolCalls: [{
      name: 'propose_final_report',
      arguments: { content, summary: ['保留原稿事实', '提交完整候选终版'] },
    }],
  }
}

test.describe('终版生成会话验收夹具', () => {
  test('通过浏览器完成会话创建、流式生成、采用与重载恢复', async ({ page, request, reportId }) => {
    const report = await request.get(`/api/reports/${reportId}`)
    expect(report.ok()).toBeTruthy()
    const bundle = await report.json()
    expect(bundle.variants).toHaveLength(2)
    const personal = bundle.variants.find((variant: { variant: string }) => variant.variant === 'personal')
    expect(personal.sourceDraft).toContain('completed deterministic work')

    await page.goto(`/edit/${reportId}`)
    await page.getByRole('button', { name: 'AI chat' }).click()
    await page.getByLabel('Template').selectOption('official-general')
    await page.getByLabel('Initial instruction (editable)').fill(scriptedInstruction('请提交完整候选终版', {
      steps: [proposalStep()],
    }))
    const streamResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().includes(`/api/reports/${reportId}/generation-sessions/`)
      && response.url().endsWith('/turns')
    ))
    const before = await request.get(`/api/reports/${reportId}`)
    expect((await before.json()).variants.find((variant: { variant: string }) => variant.variant === 'personal').finalContent).toBeNull()
    await page.getByRole('button', { name: 'Create session and send' }).click()
    const streamResponse = await streamResponsePromise
    expect(streamResponse.ok()).toBeTruthy()
    expect(streamResponse.headers()['content-type']).toContain('application/x-ndjson')
    const streamEvents = (await streamResponse.text()).trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(streamEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      'start', 'working', 'reasoning-delta', 'text-delta', 'tool-input-delta',
      'tool-call', 'tool-result', 'proposal', 'finish',
    ]))
    await expect(page.getByRole('heading', { name: 'Proposed final version' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('确定性 E2E 验收')).toBeVisible()
    await expect(page.getByText('Pending review')).toBeVisible()
    await expect(page.getByText('Accept and save final version')).toBeVisible()
    await page.getByRole('button', { name: 'Accept and save final version' }).click()
    await expect(page.getByText('Accepted')).toBeVisible()
    const after = await request.get(`/api/reports/${reportId}`)
    const acceptedVariant = (await after.json()).variants.find((variant: { variant: string }) => variant.variant === 'personal')
    expect(acceptedVariant.finalContent).toContain('确定性 E2E 验收')
    await page.getByRole('button', { name: 'Report content' }).click()
    await expect(page.getByText('Final version available')).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'AI chat' }).click()
    await expect(page.getByText('已核对原稿事实。')).toBeVisible()
    await expect(page.getByText('已准备候选终版。')).toBeVisible()
    await expect(page.getByText('调用 propose_final_report 提交候选终版')).toBeVisible()
    await expect(page.getByText('候选终版已提交，等待用户确认。')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Proposed final version' })).toBeVisible()
    await expect(page.getByText('Accepted')).toBeVisible()
  })

  test('脚本步骤在失败、截断和后续轮次之间从持久历史确定推进', async ({ page, reportId }) => {
    const recoveredContent = '# 本周完成\n\n- 多轮恢复后提交终版\n\n## 下周计划\n\n- 继续验证失败恢复'
    const instruction = scriptedInstruction('按确定性脚本验证失败、截断与恢复', {
      steps: [
        { kind: 'failure', status: 502, message: 'scripted first-turn failure' },
        { kind: 'truncated', reasoning: '第二轮推理已返回。', text: '部分输出后连接被截断。' },
        proposalStep(recoveredContent),
      ],
    })

    await page.goto(`/edit/${reportId}`)
    await page.getByRole('button', { name: 'AI chat' }).click()
    await page.getByLabel('Template').selectOption('official-general')
    await page.getByLabel('Initial instruction (editable)').fill(instruction)
    await page.getByRole('button', { name: 'Create session and send' }).click()
    await expect(page.getByText('Generation failed this turn.')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/scripted first-turn failure/).first()).toBeVisible()

    const composer = page.getByPlaceholder('Ask AI to revise, answer a question, or submit the current version...')
    await composer.fill('继续到截断步骤')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('部分输出后连接被截断。')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('No proposed final version was submitted this turn.')).toBeVisible()

    await composer.fill('继续到恢复步骤并提交终版')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Proposed final version' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('多轮恢复后提交终版')).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'AI chat' }).click()
    await expect(page.getByText(/scripted first-turn failure/).first()).toBeVisible()
    await expect(page.getByText('部分输出后连接被截断。')).toBeVisible()
    await expect(page.getByText('多轮恢复后提交终版')).toBeVisible()
  })

  test('通过公开夹具接口准备 current、stale 与 legacy 历史数据', async ({ request, scenario }) => {
    const history = await seedHistoricalReports(request, scenario)
    try {
      expect(history.map((item) => item.kind)).toEqual(['current', 'stale', 'legacy'])
      for (const item of history) {
        const response = await request.get(`/api/reports/${item.id}`)
        expect(response.ok()).toBeTruthy()
        const report = await response.json()
        if (item.kind === 'legacy') {
          expect(report.variants).toHaveLength(1)
          expect(report.variants[0].sourceRevision).toBe(0)
        } else {
          expect(report.variants).toHaveLength(2)
          expect(report.variants.every((variant: { finalStatus: string }) => variant.finalStatus === item.kind)).toBeTruthy()
        }
      }
    } finally {
      await disposeHistoricalReports(request, history)
    }
  })
})
