import { test, expect } from './generation-fixtures'
import { SCRIPTED_AI_URL, scriptedInstruction } from './scripted-ai'

function proposalStep(input: {
  content: string
  changes: string[]
  handling: string[]
}) {
  return {
    kind: 'stream' as const,
    reasoning: '这是供应商显式 reasoning，不得被推断或复制到公开生成摘要。',
    text: '已准备只读候选终版。',
    toolCalls: [{
      name: 'propose_final_report',
      arguments: {
        content: input.content,
        summary: input.changes,
        publicSummary: { modelHandling: input.handling },
      },
    }],
  }
}

async function createSession(request: import('@playwright/test').APIRequestContext, reportId: number) {
  const response = await request.post(`/api/reports/${reportId}/generation-sessions`, {
    data: { variant: 'personal', templateId: 'official-general' },
  })
  expect(response.status()).toBe(201)
  return await response.json() as { id: number }
}

test.describe('提案评审与公开生成摘要', () => {
  test.setTimeout(120_000)

  test('在只读评审中恢复摘要与三种视图，并采用到当前编辑基线', async ({ page, request, reportId, scenario }) => {
    await request.put('/api/settings/ai', {
      data: { protocol: 'openai-compatible', apiUrl: SCRIPTED_AI_URL, apiKey: 'e2e-scripted', model: 'e2e-scripted' },
    })
    const session = await createSession(request, reportId)
    const firstContent = `# 本周完成\n\n- ${scenario} current source fact`
    const secondContent = `# 本周完成\n\n- 已完成：${scenario} current source fact\n\n## 下周计划\n- 整理公开评审结论`
    const instruction = scriptedInstruction('生成并评审两轮完整提案', {
      steps: [
        proposalStep({
          content: firstContent,
          changes: ['建立首个当前编辑基线'],
          handling: ['仅依据当前受众的周报原稿整理本周事实。'],
        }),
        proposalStep({
          content: secondContent,
          changes: [
            '调整本周完成表述',
            '补充下一步评审计划',
            'c'.repeat(281),
            ...Array.from({ length: 10 }, (_, index) => `公开变更 ${index + 1}`),
          ],
          handling: ['仅依据当前受众的周报原稿重写本周完成内容。'],
        }),
      ],
    })

    await page.goto(`/edit/${reportId}`)
    const composer = page.getByPlaceholder('Ask AI to revise, answer a question, or submit the current version...')
    await composer.fill(instruction)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const review = page.getByRole('complementary', { name: 'Read-only proposal review' })
    await expect(review.getByText('Pending review')).toBeVisible({ timeout: 30_000 })
    await review.getByRole('button', { name: 'Accept and save final version' }).click()
    await expect(review.getByText('Accepted')).toBeVisible({ timeout: 30_000 })

    await composer.fill('基于当前编辑基线提交第二轮完整提案')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(review.getByText('Pending review')).toBeVisible({ timeout: 30_000 })
    await expect(review.getByRole('heading', { name: 'Public generation summary' })).toBeVisible()
    await expect(review.getByText('仅依据当前受众的周报原稿重写本周完成内容。')).toBeVisible()
    await expect(review.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0)

    await review.getByRole('tab', { name: 'Markdown source' }).click()
    await expect(review.getByTestId('proposal-markdown-source')).toContainText('# 本周完成')
    await expect(review.getByTestId('proposal-markdown-source')).toContainText('## 下周计划')
    await review.getByRole('tab', { name: 'Difference' }).click()
    await expect(review.locator('[data-diff-type="remove"]').filter({ hasText: `${scenario} current source fact` })).toHaveCount(1)
    await expect(review.locator('[data-diff-type="add"]').filter({ hasText: `已完成：${scenario} current source fact` })).toHaveCount(1)
    await review.getByRole('tab', { name: 'Rendered preview' }).click()
    await expect(review.getByRole('heading', { name: '本周完成' })).toBeVisible()

    const detailResponse = await request.get(`/api/reports/${reportId}/generation-sessions/${session.id}`)
    const detail = await detailResponse.json()
    const proposal = detail.proposals.at(-1)
    expect(proposal.baselineContent).toBe(firstContent)
    expect(proposal.content).toBe(secondContent)
    expect(proposal.publicSummary).toMatchObject({
      version: 1,
      modelHandling: ['仅依据当前受众的周报原稿重写本周完成内容。'],
      historicalReferences: [],
      toolStatuses: [{ toolName: 'propose_final_report', status: 'succeeded', detail: 'proposal-created' }],
      failureStates: [],
      factBoundary: {
        currentWeekFacts: 'report-source-draft-only',
        historicalReferences: 'untrusted',
        hiddenReasoning: 'none',
        summaryAsFact: 'none',
        scoringInput: 'none',
      },
    })
    expect(proposal.publicSummary.changeSummary).toHaveLength(12)
    expect(proposal.publicSummary.changeSummary).toEqual(expect.arrayContaining(['调整本周完成表述', '补充下一步评审计划']))
    expect(proposal.publicSummary.changeSummary[2]).toHaveLength(280)
    expect(proposal.publicSummary.truncationStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'proposal-change-summary', omittedCount: 2 }),
    ]))
    expect(JSON.stringify(proposal.publicSummary)).not.toContain('这是供应商显式 reasoning')

    await page.reload()
    const restoredReview = page.getByRole('complementary', { name: 'Read-only proposal review' })
    await expect(restoredReview.getByText('Pending review')).toBeVisible({ timeout: 30_000 })
    await expect(restoredReview.getByText('补充下一步评审计划')).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await restoredReview.getByRole('button', { name: 'Accept and save final version' }).click()
    await expect(restoredReview.getByText('Accepted')).toBeVisible({ timeout: 30_000 })

    const acceptedReport = await request.get(`/api/reports/${reportId}`)
    const acceptedVariant = (await acceptedReport.json()).variants.find((item: { variant: string }) => item.variant === 'personal')
    expect(acceptedVariant).toMatchObject({ finalContent: proposal.content, acceptedProposalId: proposal.id })
    expect(acceptedVariant.structureCompletenessRule).toBeNull()
    const acceptedDetail = await request.get(`/api/reports/${reportId}/generation-sessions/${session.id}`)
    const acceptedBody = await acceptedDetail.json()
    expect(acceptedBody.baselineFinalContent).toBe(proposal.content)
    expect(acceptedBody.proposals.at(-1).status).toBe('accepted')
    expect(acceptedBody.messages.at(-1)).toMatchObject({ partType: 'proposal-accepted', data: { proposalId: proposal.id } })
  })

  test('原稿版本变化时采用失败且不会部分更新终版', async ({ request, reportId, scenario }) => {
    const session = await createSession(request, reportId)
    const stream = await request.post(`/api/reports/${reportId}/generation-sessions/${session.id}/turns`, {
      data: {
        message: scriptedInstruction('创建等待采用的提案', {
          steps: [proposalStep({
            content: `# 本周完成\n\n- ${scenario} current source fact`,
            changes: ['生成等待采用的完整提案'],
            handling: ['仅使用当前周报原稿。'],
          })],
        }),
      },
    })
    expect(stream.ok()).toBeTruthy()
    const detail = await request.get(`/api/reports/${reportId}/generation-sessions/${session.id}`)
    const proposal = (await detail.json()).proposals[0]
    const proposalId = proposal.id as number
    expect(proposal.publicSummary).toMatchObject({
      modelHandling: ['仅使用当前周报原稿。'],
      historicalReferences: [],
      failureStates: [],
      truncationStates: [],
      changeSummary: ['生成等待采用的完整提案'],
    })
    const regenerated = await request.post(`/api/reports/${reportId}/regenerate-source`)
    expect(regenerated.ok()).toBeTruthy()

    const acceptance = await request.post(`/api/reports/${reportId}/generation-sessions/${session.id}/proposals/${proposalId}/accept`)
    expect(acceptance.status()).toBe(409)
    expect((await acceptance.json()).code).toBe('SOURCE_REVISION_CONFLICT')
    const report = await request.get(`/api/reports/${reportId}`)
    const personal = (await report.json()).variants.find((item: { variant: string }) => item.variant === 'personal')
    expect(personal.finalContent).toBeNull()
    expect(personal.acceptedProposalId).toBeNull()
    const staleDetail = await request.get(`/api/reports/${reportId}/generation-sessions/${session.id}`)
    const staleBody = await staleDetail.json()
    expect(staleBody.sourceIsCurrent).toBe(false)
    expect(staleBody.proposals[0].status).toBe('pending')
    expect(staleBody.baselineFinalContent).toBeNull()
  })
})
