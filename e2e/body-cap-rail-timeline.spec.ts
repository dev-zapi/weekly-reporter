import { test, expect, type Page } from '@playwright/test'

/**
 * body-cap rail 宽度契约（ticket #147）。
 *
 * 唯一接缝是真实页面 + 真实视口：断言只读外部可见行为——计算后的
 * grid-template-columns（两轨像素值）与元素包围盒。不断言类名、组件内部
 * 结构或 CSS 模块实现。
 *
 * 视口宽 W（>780，AppShell 未折叠）时，工作台主体的可用宽为 W - 248px
 * 左栏 - 24px gutter。契约：
 *   - ≥1450：第一轨 ≤1000，右栏 ≥380 且随视口增长；
 *   - 1000–1400：右栏贴 380 下限，中栏吃余量；
 *   - ≤960：折叠为单栏（display:block，主体与右栏同宽、竖直堆叠）。
 */

const BODY_MAX = 1000
const RAIL_MIN = 380
const RAIL_LABEL = 'Timeline context'
const PRIMARY_LABEL = 'Work evidence'
const EVENTS_PAGE_LIMIT = 30
const SEEDED_EVENTS = 45

function rail(page: Page) {
  return page.getByRole('complementary', { name: RAIL_LABEL })
}

function primary(page: Page) {
  return page.getByRole('region', { name: PRIMARY_LABEL })
}

function eventRows(page: Page) {
  return page.locator('[data-event-id]')
}

async function openTimeline(page: Page) {
  await page.goto('/')
  await expect(primary(page)).toBeVisible()
  await expect(rail(page)).toBeVisible()
}

async function readTracks(page: Page): Promise<{ primary: number; rail: number }> {
  const columns = await rail(page).evaluate(
    (el) => getComputedStyle(el.parentElement!).gridTemplateColumns,
  )
  const parts = columns.split(/\s+/).filter(Boolean).map((value) => Number.parseFloat(value))
  return { primary: parts[0], rail: parts[1] }
}

async function readLayoutDisplay(page: Page): Promise<string> {
  return rail(page).evaluate((el) => getComputedStyle(el.parentElement!).display)
}

/** Number of distinct horizontal positions the rail's direct children occupy. */
async function railChildColumns(page: Page): Promise<number> {
  const xs = await rail(page).evaluate((el) =>
    Array.from(el.children).map((child) => Math.round(child.getBoundingClientRect().x)),
  )
  return new Set(xs).size
}

test.describe('body-cap rail — timeline', () => {
  test('封顶：≥1450 中栏 ≤1000，右栏 ≥380 且随视口增长', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await openTimeline(page)

    const wide = await readTracks(page)
    expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const wideRail = await rail(page).boundingBox()
    expect(wideRail).not.toBeNull()

    await page.setViewportSize({ width: 1500, height: 1000 })
    await expect
      .poll(async () => (await readTracks(page)).rail)
      .toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const midRail = await rail(page).boundingBox()
    expect(midRail).not.toBeNull()
    // Shrinking the window hands the difference to the rail too.
    expect(wideRail!.width).toBeGreaterThan(midRail!.width + 100)
  })

  test('下限：1000–1400 右栏贴 380，中栏吃余量', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await openTimeline(page)

    let primaryAt1400 = 0
    for (const width of [1400, 1200, 1000]) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(async () => Math.abs((await readTracks(page)).rail - RAIL_MIN) <= 1)
        .toBe(true)

      const tracks = await readTracks(page)
      expect(tracks.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
      expect(tracks.rail).toBeLessThanOrEqual(RAIL_MIN + 1)
      expect(tracks.primary).toBeGreaterThan(0)
      if (width === 1400) primaryAt1400 = tracks.primary
    }

    // The primary column absorbs the window delta while the rail stays pinned.
    const primaryAt1000 = (await readTracks(page)).primary
    expect(primaryAt1400).toBeGreaterThan(primaryAt1000 + 300)
  })

  test('折叠：≤960 折叠为单栏，主体与右栏竖直堆叠', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 900 })
    await openTimeline(page)

    await expect.poll(() => readLayoutDisplay(page)).toBe('block')

    const primaryBox = await primary(page).boundingBox()
    const railBox = await rail(page).boundingBox()
    expect(primaryBox).not.toBeNull()
    expect(railBox).not.toBeNull()

    // Single column: both spans are the full body width and the rail follows
    // the primary section vertically instead of sitting beside it.
    expect(Math.abs(primaryBox!.width - railBox!.width)).toBeLessThanOrEqual(1)
    expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 1)
  })

  test('自动加载仅在 ≥961 生效', async ({ page, request }) => {
    const createdIds: number[] = []
    try {
      // Distinct timestamps keep the cursor pagination deterministic.
      const base = Date.UTC(2024, 0, 1, 8, 0, 0)
      for (let i = 0; i < SEEDED_EVENTS; i += 1) {
        const response = await request.post('/api/events', {
          data: {
            content: `body-cap rail e2e event ${i}`,
            eventTime: new Date(base + i * 60_000).toISOString(),
          },
        })
        expect(response.status()).toBe(201)
        createdIds.push((await response.json()).id)
      }

      // Wide (two-column): scrolling the sentinel appends the next page.
      await page.setViewportSize({ width: 1200, height: 900 })
      await page.goto('/')
      await expect(eventRows(page)).toHaveCount(EVENTS_PAGE_LIMIT)
      await page.getByRole('button', { name: 'Load more' }).scrollIntoViewIfNeeded()
      await expect(eventRows(page)).toHaveCount(SEEDED_EVENTS, { timeout: 10_000 })

      // Narrow (single-column): the observer is off, so reaching the bottom
      // does not append; the explicit button still paginates.
      await page.setViewportSize({ width: 900, height: 900 })
      await page.reload()
      await expect(eventRows(page)).toHaveCount(EVENTS_PAGE_LIMIT)
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(750)
      await expect(eventRows(page)).toHaveCount(EVENTS_PAGE_LIMIT)
      await page.getByRole('button', { name: 'Load more' }).click()
      await expect(eventRows(page)).toHaveCount(SEEDED_EVENTS)
    } finally {
      for (const id of createdIds) {
        await request.delete(`/api/events/${id}`)
      }
    }
  })

  test('瀑布流：宽右栏双列，窄右栏单列', async ({ page }) => {
    // 1920: rail inner width ~608px ≥ 260*2 + 20, so panels flow in two columns.
    await page.setViewportSize({ width: 1920, height: 1000 })
    await openTimeline(page)
    await expect.poll(() => railChildColumns(page)).toBeGreaterThanOrEqual(2)

    // 1450: rail is pinned at 380px (inner ~340px < 540px), so panels fall back
    // to a single natural column.
    await page.setViewportSize({ width: 1450, height: 1000 })
    await expect
      .poll(async () => Math.abs((await readTracks(page)).rail - RAIL_MIN) <= 1)
      .toBe(true)
    await expect.poll(() => railChildColumns(page)).toBe(1)
  })

  test('语义：Rail label 映射 aside 的 aria-label，页面 heading 保持区域标签', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    await openTimeline(page)

    await expect(rail(page)).toHaveAttribute('aria-label', RAIL_LABEL)
    await expect(page.getByRole('heading', { level: 1, name: PRIMARY_LABEL })).toBeVisible()
  })
})
