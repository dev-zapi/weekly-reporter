import { test, expect, type Page } from '@playwright/test'
import {
  BODY_MAX,
  RAIL_MIN,
  expectCollapsed,
  primary,
  rail,
  railChildColumns,
  readSurfaceWidths,
  readTracks,
} from './body-cap-rail-helpers'

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
 *   - 1000–1400：右栏贴 380 下限，中栏吃余量；
 *   - ≤960：折叠为单栏（display:block，主体与右栏同宽、竖直堆叠）。
 */

/**
 * 1000–1400：右栏贴 380 下限，中栏吃余量。宽屏轨值已由各页「封顶」用例覆盖，
 * 这里只验证中区采样。
 */
async function expectRailPinned(page: Page, railLabel: string, path: string) {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(path)
  await expect(rail(page, railLabel)).toBeVisible()

  let primaryAt1400 = 0
  for (const width of [1400, 1200, 1000]) {
    await page.setViewportSize({ width, height: 900 })
    await expect
      .poll(async () => Math.abs((await readTracks(page, railLabel)).rail - RAIL_MIN) <= 1)
      .toBe(true)

    const tracks = await readTracks(page, railLabel)
    expect(tracks.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
    expect(tracks.rail).toBeLessThanOrEqual(RAIL_MIN + 1)
    expect(tracks.primary).toBeGreaterThan(0)
    if (width === 1400) primaryAt1400 = tracks.primary
  }

  // The primary column absorbs the window delta while the rail stays pinned.
  const primaryAt1000 = (await readTracks(page, railLabel)).primary
  expect(primaryAt1400).toBeGreaterThan(primaryAt1000 + 200)
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

  test('下限：1000–1400 右栏贴 380，中栏吃余量', async ({ page }) => {
    await expectRailPinned(page, RAIL_LABEL, '/new')
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

  test('下限：1000–1400 右栏贴 380，中栏吃余量', async ({ page }) => {
    await expectRailPinned(page, RAIL_LABEL, '/plans')
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

  test('下限：1000–1400 右栏贴 380，中栏吃余量', async ({ page }) => {
    await expectRailPinned(page, RAIL_LABEL, `/templates/${templateId}`)
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
    { path: '/collect/new', heading: 'New source' },
    { path: '/templates/new', heading: 'New Template' },
    { path: '/prompts', heading: 'Prompt Management' },
  ]

  /**
   * The route surface must fill the shell body at every desktop width and keep
   * following viewport growth — the "unchanged full-width status" for pages
   * outside the body-cap rail scope. Measured through `<main>` and its first
   * child, so no page internals are asserted.
   */
  async function expectSurfaceFillsBody(page: Page) {
    const at1280 = await readSurfaceWidths(page)
    expect(Math.abs(at1280.surface - at1280.main)).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 1920, height: 900 })
    const at1920 = await readSurfaceWidths(page)
    expect(Math.abs(at1920.surface - at1920.main)).toBeLessThanOrEqual(1)

    // Full-width status is unchanged: the route surface follows the shell
    // body delta, not the 1000px body cap.
    expect(at1920.surface).toBeGreaterThan(BODY_MAX + 1)
    expect(at1920.surface - at1280.surface).toBeGreaterThan(600)
  }

  for (const { path, heading } of cases) {
    test(`${path} 满宽不变，未进入 body-cap 栅格`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()

      await expectSurfaceFillsBody(page)
    })
  }

  test('/collect/:id 满宽不变，未进入 body-cap 栅格', async ({ page, request }) => {
    const created = await request.post('/api/collect/sources', {
      data: {
        type: 'git-local',
        name: 'body-cap rail e2e source',
        projectScope: 'personal',
        config: {
          owner: '/tmp/body-cap-rail-e2e',
          authorEmails: ['e2e@example.com'],
        },
      },
    })
    expect(created.status()).toBe(201)
    const { id } = (await created.json()) as { id: number }

    try {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(`/collect/${id}`)
      await expect(
        page.getByRole('heading', { level: 1, name: `Edit source #${id}` }),
      ).toBeVisible()

      await expectSurfaceFillsBody(page)
    } finally {
      await request.delete(`/api/collect/sources/${id}`)
    }
  })
})
