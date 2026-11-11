import { test, expect, type Page } from '@playwright/test'

/**
 * body-cap rail 宽度契约（ticket #151 — 最后三处两栏页面）。
 *
 * 唯一接缝是真实页面 + 真实视口：断言只读外部可见行为——计算后的
 * grid-template-columns（两轨像素值）、元素包围盒与右栏子元素横向落位。
 * 不断言类名、组件内部结构或 CSS 模块实现。
 *
 * 视口宽 W（>780，AppShell 未折叠）时，工作台主体的可用宽为 W - 248px
 * 左栏 - 24px gutter。契约与 #147 一致：
 *   - ≥1450：第一轨 ≤1000，右栏 ≥380 且随视口增长；
 *   - ≤960：折叠为单栏（display:block，主体与右栏同宽、竖直堆叠）。
 */

const BODY_MAX = 1000
const RAIL_MIN = 380

function rail(page: Page, label: string) {
  return page.getByRole('complementary', { name: label })
}

function primary(page: Page, name: string) {
  return page.getByRole('region', { name })
}

async function readTracks(
  page: Page,
  railLabel: string,
): Promise<{ primary: number; rail: number }> {
  const columns = await rail(page, railLabel).evaluate(
    (el) => getComputedStyle(el.parentElement!).gridTemplateColumns,
  )
  const parts = columns.split(/\s+/).filter(Boolean).map((value) => Number.parseFloat(value))
  return { primary: parts[0], rail: parts[1] }
}

async function readLayoutDisplay(page: Page, railLabel: string): Promise<string> {
  return rail(page, railLabel).evaluate((el) => getComputedStyle(el.parentElement!).display)
}

/** Number of distinct horizontal positions the rail's direct children occupy. */
async function railChildColumns(page: Page, railLabel: string): Promise<number> {
  const xs = await rail(page, railLabel).evaluate((el) =>
    Array.from(el.children).map((child) => Math.round(child.getBoundingClientRect().x)),
  )
  return new Set(xs).size
}

async function expectCollapsed(page: Page, railLabel: string, primaryName: string) {
  await expect.poll(() => readLayoutDisplay(page, railLabel)).toBe('block')

  const primaryBox = await primary(page, primaryName).boundingBox()
  const railBox = await rail(page, railLabel).boundingBox()
  expect(primaryBox).not.toBeNull()
  expect(railBox).not.toBeNull()

  expect(Math.abs(primaryBox!.width - railBox!.width)).toBeLessThanOrEqual(1)
  expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 1)
}

test.describe('body-cap rail — new report (/new)', () => {
  const RAIL_LABEL = 'Report creation settings'
  const PRIMARY_NAME = 'New Report'

  test('封顶：≥1450 中栏 ≤1000，右栏 ≥380 且随视口增长', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto('/new')
    await expect(primary(page, PRIMARY_NAME)).toBeVisible()
    await expect(rail(page, RAIL_LABEL)).toBeVisible()

    const wide = await readTracks(page, RAIL_LABEL)
    expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const wideRail = await rail(page, RAIL_LABEL).boundingBox()
    expect(wideRail).not.toBeNull()

    await page.setViewportSize({ width: 1450, height: 1000 })
    await expect.poll(async () => Math.abs((await readTracks(page, RAIL_LABEL)).rail - RAIL_MIN) <= 1).toBe(true)

    const narrowRail = await rail(page, RAIL_LABEL).boundingBox()
    expect(narrowRail).not.toBeNull()
    expect(wideRail!.width).toBeGreaterThan(narrowRail!.width + 100)
  })

  test('折叠：≤960 折叠为单栏，主体与右栏竖直堆叠', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 900 })
    await page.goto('/new')
    await expect(rail(page, RAIL_LABEL)).toBeVisible()
    await expectCollapsed(page, RAIL_LABEL, PRIMARY_NAME)
  })
})

test.describe('body-cap rail — period plans (/plans)', () => {
  const RAIL_LABEL = 'Plan inspector'
  const PRIMARY_NAME = 'Plan workspace'

  test('封顶：≥1450 中栏 ≤1000，右栏 ≥380 且随视口增长', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto('/plans')
    await expect(primary(page, PRIMARY_NAME)).toBeVisible()
    await expect(rail(page, RAIL_LABEL)).toBeVisible()

    const wide = await readTracks(page, RAIL_LABEL)
    expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const wideRail = await rail(page, RAIL_LABEL).boundingBox()
    expect(wideRail).not.toBeNull()

    await page.setViewportSize({ width: 1450, height: 1000 })
    await expect.poll(async () => Math.abs((await readTracks(page, RAIL_LABEL)).rail - RAIL_MIN) <= 1).toBe(true)

    const narrowRail = await rail(page, RAIL_LABEL).boundingBox()
    expect(narrowRail).not.toBeNull()
    expect(wideRail!.width).toBeGreaterThan(narrowRail!.width + 100)
  })

  test('瀑布流：宽右栏双列，窄右栏单列', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto('/plans')
    await expect(rail(page, RAIL_LABEL)).toBeVisible()
    await expect.poll(() => railChildColumns(page, RAIL_LABEL)).toBeGreaterThanOrEqual(2)

    await page.setViewportSize({ width: 1450, height: 1000 })
    await expect.poll(async () => Math.abs((await readTracks(page, RAIL_LABEL)).rail - RAIL_MIN) <= 1).toBe(true)
    await expect.poll(() => railChildColumns(page, RAIL_LABEL)).toBe(1)
  })

  test('折叠：≤960 折叠为单栏，主体与右栏竖直堆叠', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 900 })
    await page.goto('/plans')
    await expect(rail(page, RAIL_LABEL)).toBeVisible()
    await expectCollapsed(page, RAIL_LABEL, PRIMARY_NAME)
  })
})

test.describe('body-cap rail — template edit (/templates/:id)', () => {
  const RAIL_LABEL = 'Generation style'
  const PRIMARY_NAME = 'Template editor'
  let templateId: number

  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/templates', {
      data: {
        name: 'body-cap rail e2e template',
        content: '## Section\n\nTemplate body for the layout contract.',
      },
    })
    expect(response.status()).toBe(201)
    templateId = (await response.json()).template.id
  })

  test.afterEach(async ({ request }) => {
    await request.delete(`/api/templates/${templateId}`)
  })

  test('封顶：≥1450 中栏 ≤1000，右栏 ≥380 且随视口增长', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto(`/templates/${templateId}`)
    await expect(primary(page, PRIMARY_NAME)).toBeVisible()
    await expect(rail(page, RAIL_LABEL)).toBeVisible()

    const wide = await readTracks(page, RAIL_LABEL)
    expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const wideRail = await rail(page, RAIL_LABEL).boundingBox()
    expect(wideRail).not.toBeNull()

    await page.setViewportSize({ width: 1450, height: 1000 })
    await expect.poll(async () => Math.abs((await readTracks(page, RAIL_LABEL)).rail - RAIL_MIN) <= 1).toBe(true)

    const narrowRail = await rail(page, RAIL_LABEL).boundingBox()
    expect(narrowRail).not.toBeNull()
    expect(wideRail!.width).toBeGreaterThan(narrowRail!.width + 100)
  })

  test('折叠：≤960 折叠为单栏，主体与右栏竖直堆叠', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 900 })
    await page.goto(`/templates/${templateId}`)
    await expect(rail(page, RAIL_LABEL)).toBeVisible()
    await expectCollapsed(page, RAIL_LABEL, PRIMARY_NAME)
  })
})

/**
 * Single-column pages are explicitly out of the body-cap rail scope. Their
 * surface fills the shell body at every desktop width and is never capped at
 * `--wr-body-max` — that is the "unchanged full-width status" the ticket asks
 * us to guard. Measured through the shell body (`main`) and the route surface
 * it wraps, so no page internals are asserted.
 */
test.describe('body-cap rail — single-column pages stay full width', () => {
  const cases = [
    { path: '/templates', heading: 'Template Management' },
    { path: '/security', heading: 'Security' },
    { path: '/collect', heading: 'Collection sources' },
  ]

  async function readSurface(page: Page): Promise<{ body: number; surface: number }> {
    return page.evaluate(() => {
      const body = document.querySelector('main')
      const surface = body?.firstElementChild as HTMLElement | null
      if (!body || !surface) throw new Error('shell body surface not found')
      return {
        body: body.getBoundingClientRect().width,
        surface: surface.getBoundingClientRect().width,
      }
    })
  }

  for (const { path, heading } of cases) {
    test(`${path} 满宽不变，未进入 body-cap 栅格`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()

      const at1280 = await readSurface(page)
      expect(Math.abs(at1280.surface - at1280.body)).toBeLessThanOrEqual(1)

      await page.setViewportSize({ width: 1920, height: 900 })
      const at1920 = await readSurface(page)
      expect(Math.abs(at1920.surface - at1920.body)).toBeLessThanOrEqual(1)

      // Full-width status is unchanged: the route surface follows the shell
      // body delta, not the 1000px body cap.
      expect(at1920.surface).toBeGreaterThan(BODY_MAX + 1)
      expect(at1920.surface - at1280.surface).toBeGreaterThan(600)
    })
  }
})
