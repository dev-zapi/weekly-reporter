import { test, expect } from '@playwright/test'

/**
 * 新建周报页面的原稿事件填充。
 *
 * 原 `new-page-template-events.spec.ts` 断言 /new 上的「模板选择器 + 编辑器」——
 * 那套 UI 已随报告侧计划机制删除（ADR-0021）移除：/new 现在按周生成确定性
 * 原稿（领导版/个人版双受众预览），模板只影响终版生成会话，不再出现在这里。
 * 本文件保留原用例的核心意图——本周事件应进入新周报的原稿——并按当前 UI 断言。
 */
test.describe('新建周报页面 - 原稿事件填充', () => {
  const createdEventIds: number[] = []

  test.beforeEach(async ({ request }) => {
    // Seed pending events for the current week
    const now = new Date()
    const events = [
      {
        content: '完成了用户认证模块的开发和测试',
        eventTime: now.toISOString(),
      },
      {
        content: '优化了数据库查询性能，响应时间提升 50%',
        eventTime: now.toISOString(),
      },
      {
        content: '准备下周的技术分享会材料',
        eventTime: now.toISOString(),
      },
    ]

    for (const event of events) {
      const response = await request.post('/api/events', {
        data: event,
      })
      expect(response.ok()).toBeTruthy()
      const data = await response.json()
      createdEventIds.push(data.id)
    }
  })

  test.afterEach(async ({ request }) => {
    // Clean up created events
    for (const id of createdEventIds) {
      await request.delete(`/api/events/${id}`)
    }
    createdEventIds.length = 0
  })

  test('原稿预览的领导版应包含本周事件', async ({ page }) => {
    await page.goto('/new')

    const preview = page.getByRole('region', { name: 'Source draft preview' })
    await expect(preview).toBeVisible()
    // Leadership 是默认选中的受众页签
    await expect(preview.getByRole('tab', { name: 'Leadership' })).toHaveAttribute('aria-selected', 'true')

    await expect(preview.getByRole('tabpanel')).toContainText('完成了用户认证模块的开发和测试')
    await expect(preview.getByRole('tabpanel')).toContainText('优化了数据库查询性能，响应时间提升 50%')
    await expect(preview.getByRole('tabpanel')).toContainText('准备下周的技术分享会材料')
  })

  test('切换到个人版页签后事件同样进入原稿', async ({ page }) => {
    await page.goto('/new')

    const preview = page.getByRole('region', { name: 'Source draft preview' })
    await expect(preview).toBeVisible()
    await preview.getByRole('tab', { name: 'Personal' }).click()

    await expect(preview.getByRole('tabpanel')).toContainText('完成了用户认证模块的开发和测试')
    await expect(preview.getByRole('tabpanel')).toContainText('准备下周的技术分享会材料')
  })
})
