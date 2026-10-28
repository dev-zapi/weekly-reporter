import { test, expect } from '@playwright/test'

// 勾选框用可访问名定位（SourceFilterPanel 的 checkbox 带 aria-label）：
// 时间线页上还有 TimelinePlanPanel 的状态过滤勾选框（默认有两项勾选），
// 此前 `getByRole('checkbox').first()` 依赖面板加载顺序，撞上计划面板先渲染
// 时会把「已勾选」的计划项点成未勾选，导致用例随机变红。
test.describe('采集源过滤记忆功能', () => {
  test('刷新页面后应该保留筛选状态', async ({ page }) => {
    await page.goto('/')

    const manualCheckbox = page.getByRole('checkbox', { name: 'Manual source filter' })
    await manualCheckbox.click()

    // 验证复选框已选中
    await expect(manualCheckbox).toBeChecked()

    // 刷新页面
    await page.reload()

    // 验证筛选状态被保留
    await expect(manualCheckbox).toBeChecked()
  })

  test('应该能够从 sessionStorage 恢复筛选状态', async ({ page }) => {
    await page.goto('/')

    const manualCheckbox = page.getByRole('checkbox', { name: 'Manual source filter' })
    await manualCheckbox.click()

    // 验证 sessionStorage 中已保存
    const savedSources = await page.evaluate(() => {
      return sessionStorage.getItem('selectedSources')
    })
    expect(savedSources).toBe('["manual"]')

    // 刷新页面
    await page.reload()

    // 验证状态被恢复
    await expect(manualCheckbox).toBeChecked()
  })
})
