import { test, expect } from '@playwright/test'

test.describe('采集源搜索框焦点', () => {
  test('输入时搜索框不应丢失焦点并记录日志', async ({ page }) => {
    const consoleLogs: string[] = []
    page.on('console', (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => {
      consoleLogs.push(`[pageerror] ${err.message}`)
    })

    await page.goto('/collect')
    await page.waitForLoadState('networkidle')
    const input = page.locator('input[placeholder="Search by name…"]')
    await input.waitFor({ state: 'visible', timeout: 10000 })

    await input.click()

    // 监听焦点变化
    const focusInfo = await page.evaluateHandle(() => {
      const input = document.querySelector('input[placeholder="Search by name…"]') as HTMLInputElement | null
      if (!input) return { activeElementTag: '', activeElementPlaceholder: '', lostCount: 0 }

      let lostCount = 0
      input.addEventListener('blur', () => lostCount++)

      return {
        get activeElementTag() { return document.activeElement?.tagName || '' },
        get activeElementPlaceholder() { return (document.activeElement as HTMLInputElement | null)?.placeholder || '' },
        get lostCount() { return lostCount }
      }
    })

    await input.type('source-1', { delay: 30 })

    const info = await focusInfo.evaluate(h => ({
      activeElementTag: h.activeElementTag,
      activeElementPlaceholder: h.activeElementPlaceholder,
      lostCount: h.lostCount
    }))

    console.log('Focus info:', info)
    console.log('Console logs:', consoleLogs)

    await expect(input).toBeFocused()
    expect(info.lostCount).toBe(0)
  })
})
