import { test, expect } from '@playwright/test'

test.describe('首页', () => {
  test('应该正常加载', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/.*/)
    await expect(page.locator('h1, h2, h3').first()).toBeVisible()
  })

  test('应该显示来源筛选面板', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Filter by source')).toBeVisible()
    await expect(page.getByText('Manual')).toBeVisible()
    await expect(page.getByText('Automatic')).toBeVisible()
  })
})
