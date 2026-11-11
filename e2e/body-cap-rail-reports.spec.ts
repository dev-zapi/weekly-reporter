import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  BODY_MAX,
  RAIL_MIN,
  primary,
  rail,
  readLayoutDisplay,
  readTracks,
} from './body-cap-rail-helpers'

/**
 * body-cap rail 宽度契约（ticket #148，周报列表页）。
 *
 * 与时间线先例（body-cap-rail-timeline.spec.ts）同一接缝：真实页面 + 真实
 * 视口。断言只读外部可见行为——计算后的 grid-template-columns、元素包围盒、
 * 预览文档容器宽度与受众标签页；不断言类名或组件内部结构。
 *
 * 页面主体可用宽 W = 视口 - 248px 左栏 - 24px gutter（AppShell，>780 时）。
 * 契约：
 *   - ≥1450：第一轨 ≤1000，右栏 ≥380 且随视口增长，预览面板填满右栏；
 *   - 961–1100：右栏贴 380 下限（1100 过渡档已删除）；
 *   - ≤960：折叠为单栏（display:block，主体与右栏竖直堆叠）；
 *   - 预览正文保持 72ch 行宽，不随右栏拉伸解除；
 *   - Leadership/Personal 预览与 Open full review 链路不受影响。
 */

const RAIL_LABEL = 'Selected report preview'
const PRIMARY_LABEL = 'Report library'

const REPORT_TITLE = 'Rail contract report'
const LEADERSHIP_HEADING = 'Leadership final heading'
const LEADERSHIP_BODY = 'Leadership body paragraph for the rail contract preview.'
const PERSONAL_HEADING = 'Personal final heading'
const PERSONAL_BODY = 'Personal body paragraph for the rail contract preview.'

/** Seeds one report and gives both audience variants a final so the preview renders. */
async function seedReport(request: APIRequestContext): Promise<number> {
  const created = await request.post('/api/reports', {
    data: {
      title: REPORT_TITLE,
      weekStart: '2030-01-07T00:00:00.000Z',
      weekEnd: '2030-01-13T00:00:00.000Z',
    },
  })
  expect(created.status()).toBe(201)
  const id = ((await created.json()) as { report: { id: number } }).report.id

  for (const [variant, content] of [
    ['leadership', `# ${LEADERSHIP_HEADING}\n\n${LEADERSHIP_BODY}`],
    ['personal', `# ${PERSONAL_HEADING}\n\n${PERSONAL_BODY}`],
  ] as const) {
    const saved = await request.put(`/api/reports/${id}/final`, { data: { variant, content } })
    expect(saved.ok()).toBeTruthy()
  }
  return id
}

async function openReports(page: Page, reportId: number) {
  await page.goto('/reports')
  await expect(primary(page, PRIMARY_LABEL)).toBeVisible()
  await expect(rail(page, RAIL_LABEL)).toBeVisible()
  await page
    .getByRole('listitem')
    .filter({ hasText: REPORT_TITLE })
    .getByRole('button')
    .first()
    .click()
  await expect(rail(page, RAIL_LABEL).getByRole('heading', { name: LEADERSHIP_HEADING })).toBeVisible()
  return reportId
}

test.describe('body-cap rail — report library', () => {
  let reportId: number

  test.beforeEach(async ({ request }) => {
    reportId = await seedReport(request)
  })

  test.afterEach(async ({ request }) => {
    await request.delete(`/api/reports/${reportId}`)
  })

  test('封顶与弹性：≥1450 中栏 ≤1000，右栏 ≥380 且随视口增长，预览面板填满右栏', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await openReports(page, reportId)

    const wide = await readTracks(page, RAIL_LABEL)
    expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const wideRail = await rail(page, RAIL_LABEL).boundingBox()
    const widePanel = await page.getByRole('tabpanel').boundingBox()
    expect(wideRail).not.toBeNull()
    expect(widePanel).not.toBeNull()

    // The preview panel is not a fixed-width strip: it fills the rail's padded
    // content box (20px padding on each side).
    expect(widePanel!.width).toBeGreaterThanOrEqual(wideRail!.width - 44)
    expect(widePanel!.width).toBeLessThanOrEqual(wideRail!.width)

    // Growing the window hands the extra width to the rail.
    await page.setViewportSize({ width: 1600, height: 1000 })
    await expect.poll(async () => (await readTracks(page, RAIL_LABEL)).rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
    const midRail = await rail(page, RAIL_LABEL).boundingBox()
    const midPanel = await page.getByRole('tabpanel').boundingBox()
    expect(midRail).not.toBeNull()
    expect(midPanel).not.toBeNull()
    expect(wideRail!.width).toBeGreaterThan(midRail!.width + 100)
    expect(widePanel!.width).toBeGreaterThan(midPanel!.width + 100)
  })

  test('行宽：预览正文保持 72ch，不随右栏拉伸解除', async ({ page }) => {
    /** Width of the rendered markdown body and of the panel's padded content box. */
    async function measure(): Promise<{ body: number; panelContent: number }> {
      const body = await page
        .getByRole('heading', { name: LEADERSHIP_HEADING })
        .evaluate((heading) => heading.parentElement!.getBoundingClientRect().width)
      const panel = await page.getByRole('tabpanel').boundingBox()
      expect(panel).not.toBeNull()
      // 18px padding + 1px border on each side.
      return { body, panelContent: panel!.width - 38 }
    }

    await page.setViewportSize({ width: 2400, height: 1000 })
    await openReports(page, reportId)

    const at2400 = await measure()
    // The container is wider than the line, i.e. the 72ch measure is engaged.
    expect(at2400.body).toBeLessThan(at2400.panelContent - 100)
    expect(at2400.body).toBeGreaterThan(400)

    // A wider rail must not lengthen the line.
    await page.setViewportSize({ width: 2600, height: 1000 })
    await expect.poll(async () => (await readTracks(page, RAIL_LABEL)).rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
    const at2600 = await measure()
    expect(at2600.panelContent).toBeGreaterThan(at2400.panelContent + 100)
    expect(Math.abs(at2600.body - at2400.body)).toBeLessThanOrEqual(1)

    // When the rail sits at its 380px floor the line fills the narrower panel
    // instead of overflowing it.
    await page.setViewportSize({ width: 1600, height: 1000 })
    await expect.poll(async () => (await readTracks(page, RAIL_LABEL)).rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
    const at1600 = await measure()
    expect(at1600.body).toBeLessThan(at2400.body - 50)
    expect(Math.abs(at1600.body - at1600.panelContent)).toBeLessThanOrEqual(1)
  })

  test('下限与折叠：961–1100 右栏贴 380，≤960 折叠为单栏', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await openReports(page, reportId)

    let primaryAt1100 = 0
    for (const width of [1100, 1000, 961]) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(async () => Math.abs((await readTracks(page, RAIL_LABEL)).rail - RAIL_MIN) <= 1)
        .toBe(true)

      const tracks = await readTracks(page, RAIL_LABEL)
      expect(tracks.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
      expect(tracks.rail).toBeLessThanOrEqual(RAIL_MIN + 1)
      expect(tracks.primary).toBeGreaterThan(0)
      if (width === 1100) primaryAt1100 = tracks.primary
    }

    // The primary column absorbs the window delta while the rail stays pinned;
    // the retired 1100px transition would have pinned the rail at 300px.
    const primaryAt961 = (await readTracks(page, RAIL_LABEL)).primary
    expect(primaryAt1100).toBeGreaterThan(primaryAt961 + 100)

    await page.setViewportSize({ width: 960, height: 900 })
    await expect.poll(() => readLayoutDisplay(page, RAIL_LABEL)).toBe('block')

    const primaryBox = await primary(page, PRIMARY_LABEL).boundingBox()
    const railBox = await rail(page, RAIL_LABEL).boundingBox()
    expect(primaryBox).not.toBeNull()
    expect(railBox).not.toBeNull()
    expect(Math.abs(primaryBox!.width - railBox!.width)).toBeLessThanOrEqual(1)
    expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 1)
  })

  test('受众与全文链路：Leadership/Personal 预览与 Open full review 不受影响', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    await openReports(page, reportId)

    const leadershipTab = rail(page, RAIL_LABEL).getByRole('tab', { name: /Leadership/ })
    const personalTab = rail(page, RAIL_LABEL).getByRole('tab', { name: /Personal/ })
    await expect(leadershipTab).toHaveAttribute('aria-selected', 'true')
    await expect(rail(page, RAIL_LABEL).getByRole('heading', { name: LEADERSHIP_HEADING })).toBeVisible()
    await expect(rail(page, RAIL_LABEL).getByText(LEADERSHIP_BODY)).toBeVisible()

    await personalTab.click()
    await expect(personalTab).toHaveAttribute('aria-selected', 'true')
    await expect(rail(page, RAIL_LABEL).getByRole('heading', { name: PERSONAL_HEADING })).toBeVisible()
    await expect(rail(page, RAIL_LABEL).getByText(PERSONAL_BODY)).toBeVisible()
    await expect(rail(page, RAIL_LABEL).getByRole('heading', { name: LEADERSHIP_HEADING })).toHaveCount(0)

    const reviewLink = rail(page, RAIL_LABEL).getByRole('link', { name: /Open full review/ })
    await expect(reviewLink).toHaveAttribute('href', `/reports/${reportId}?audience=personal`)

    await reviewLink.click()
    await expect(page).toHaveURL(new RegExp(`/reports/${reportId}\\?audience=personal$`))
    await expect(page.getByRole('heading', { name: REPORT_TITLE })).toBeVisible()
  })
})
