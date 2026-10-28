import { test, expect } from '@playwright/test'

test.describe('新建周报页面 - 模板事件填充', () => {
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

  test('选择官方模板后应显示事件内容而非示例文本', async ({ page }) => {
    await page.goto('/new')

    // Wait for the page to load and template to be selected
    await expect(page.getByLabel('模板')).toBeVisible()

    // Select the first official template (通用正式周报模板)
    const templateSelect = page.getByLabel('模板')
    await templateSelect.click()

    // Wait for the template to render
    await page.waitForTimeout(500)

    // Get the editor content
    const editor = page.locator('.ProseMirror, [contenteditable="true"]').first()
    const content = await editor.textContent()

    // Verify that event content is present
    expect(content).toContain('完成了用户认证模块的开发和测试')
    expect(content).toContain('优化了数据库查询性能')
    expect(content).toContain('准备下周的技术分享会材料')

    // Verify that example text is NOT present
    expect(content).not.toContain('[工作项1')
    expect(content).not.toContain('[工作项2')
    expect(content).not.toContain('[项目/任务名称')
    expect(content).not.toContain('[计划事项')
  })

  test('切换模板后应重新渲染事件', async ({ page }) => {
    await page.goto('/new')

    // Wait for the page to load
    await expect(page.getByLabel('模板')).toBeVisible()

    // Select a different template (技术研发专属周报模板)
    const templateSelect = page.getByLabel('模板')
    await templateSelect.click()

    // Select the tech-dev template from dropdown
    const techDevOption = page.getByText('技术研发专属周报模板')
    if (await techDevOption.isVisible()) {
      await techDevOption.click()
    }

    // Wait for the template to render
    await page.waitForTimeout(500)

    // Get the editor content
    const editor = page.locator('.ProseMirror, [contenteditable="true"]').first()
    const content = await editor.textContent()

    // Verify that event content is present (events should be mapped to appropriate sections)
    expect(content).toContain('完成了用户认证模块的开发和测试')

    // Verify that placeholders are replaced
    expect(content).not.toContain('{{开发进度}}')
    expect(content).not.toContain('{{Bug修复}}')
    expect(content).not.toContain('{{运维工作}}')
  })

  test('极简模板应正确显示事件', async ({ page }) => {
    await page.goto('/new')

    // Wait for the page to load
    await expect(page.getByLabel('模板')).toBeVisible()

    // Select the minimal template
    const templateSelect = page.getByLabel('模板')
    await templateSelect.click()

    // Select the minimal template from dropdown
    const minimalOption = page.getByText('极简快速周报模板')
    if (await minimalOption.isVisible()) {
      await minimalOption.click()
    }

    // Wait for the template to render
    await page.waitForTimeout(500)

    // Get the editor content
    const editor = page.locator('.ProseMirror, [contenteditable="true"]').first()
    const content = await editor.textContent()

    // Verify that event content is present
    expect(content).toContain('完成了用户认证模块的开发和测试')

    // Verify that example text is NOT present
    expect(content).not.toContain('[关键成果1]')
    expect(content).not.toContain('[关键成果2]')
    expect(content).not.toContain('[重点事项]')
  })

  test('个人复盘模板应正确显示事件', async ({ page }) => {
    await page.goto('/new')

    // Wait for the page to load
    await expect(page.getByLabel('模板')).toBeVisible()

    // Select the personal review template
    const templateSelect = page.getByLabel('模板')
    await templateSelect.click()

    // Select the personal review template from dropdown
    const personalOption = page.getByText('个人复盘周报模板')
    if (await personalOption.isVisible()) {
      await personalOption.click()
    }

    // Wait for the template to render
    await page.waitForTimeout(500)

    // Get the editor content
    const editor = page.locator('.ProseMirror, [contenteditable="true"]').first()
    const content = await editor.textContent()

    // Verify that event content is present
    expect(content).toContain('完成了用户认证模块的开发和测试')

    // Verify that example text is NOT present
    expect(content).not.toContain('[成果1')
    expect(content).not.toContain('[成果2')
    expect(content).not.toContain('[踩坑点')
    expect(content).not.toContain('[学习内容')
  })
})
