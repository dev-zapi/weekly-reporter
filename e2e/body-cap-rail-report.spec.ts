import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  BODY_MAX,
  RAIL_MIN,
  primary as primaryRegion,
  rail,
  readLayoutDisplay,
  readSurfaceWidths,
  readTracks,
} from './body-cap-rail-helpers'

/**
 * body-cap rail 宽度契约 — 周报详情（ticket #149）。
 *
 * 唯一接缝仍是真实页面 + 真实视口：断言只读外部可见行为——计算后的
 * grid-template-columns、元素包围盒与语义角色。不断言类名或组件内部结构。
 *
 * 周报详情的两栏（内容模式）由 WorkbenchLayout 承载：
 *   - ≥1450：第一轨 ≤1000，右栏 ≥380 且随视口增长；
 *   - ≤960：折叠为单栏；
 *   - Review gate 在宽右栏里是双栏卡片：steps 在左、provenance 在右；
 *   - `.surface` 的 1500px 总上限解除，内容与 AI chat 模式都满宽；
 *     但 generation 内部的行宽控制（createPanel 760 居中）保持不变。
 */

const RAIL_LABEL = 'Report review gate'
const WEEK_START = '2027-03-01T00:00:00.000Z'
const WEEK_END = '2027-03-07T00:00:00.000Z'
const FINAL_CONTENT = '# Body cap rail final\n\nFinal body content for the layout contract.'

function primary(page: Page, audience = 'Personal') {
  return primaryRegion(page, `${audience} report review`)
}

async function seedReport(request: APIRequestContext): Promise<number> {
  const response = await request.post('/api/reports', {
    data: {
      title: 'body-cap rail report',
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    },
  })
  expect(response.status()).toBe(201)
  const payload = (await response.json()) as { report: { id: number } }

  const save = await request.put(`/api/reports/${payload.report.id}/final`, {
    data: { variant: 'personal', content: FINAL_CONTENT },
  })
  expect(save.ok()).toBeTruthy()
  return payload.report.id
}

async function openContent(page: Page, reportId: number, editable = false) {
  await page.goto(editable ? `/edit/${reportId}` : `/reports/${reportId}`)
  if (editable) {
    await page.getByRole('button', { name: 'Report content' }).click()
  }
  await expect(primary(page)).toBeVisible()
  await expect(rail(page, RAIL_LABEL)).toBeVisible()
}

test.describe('body-cap rail — report detail', () => {
  test('宽视口：中栏 ≤1000、右栏 ≥380，Review gate steps 与 provenance 并列', async ({
    page,
    request,
  }) => {
    const reportId = await seedReport(request)
    try {
      await page.setViewportSize({ width: 1920, height: 1000 })
      await openContent(page, reportId)

      const wide = await readTracks(page, RAIL_LABEL)
      expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
      expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

      const wideRailBox = await rail(page, RAIL_LABEL).boundingBox()
      expect(wideRailBox).not.toBeNull()

      // Two-column gate card: the steps list and provenance list share a row.
      const steps = rail(page, RAIL_LABEL).locator('ol')
      const provenance = rail(page, RAIL_LABEL).locator('dl')
      const stepsBox = await steps.boundingBox()
      const provenanceBox = await provenance.boundingBox()
      expect(stepsBox).not.toBeNull()
      expect(provenanceBox).not.toBeNull()
      expect(stepsBox!.x + stepsBox!.width).toBeLessThanOrEqual(provenanceBox!.x + 1)
      expect(Math.abs(stepsBox!.y - provenanceBox!.y)).toBeLessThanOrEqual(1)
      expect(provenanceBox!.width).toBeGreaterThan(100)

      // Shrinking the window keeps the rail at its token minimum and hands the
      // difference to the primary column (the wide rail was larger).
      await page.setViewportSize({ width: 1450, height: 1000 })
      await expect
        .poll(async () => (await readTracks(page, RAIL_LABEL)).rail)
        .toBeGreaterThanOrEqual(RAIL_MIN - 1)

      const pinned = await readTracks(page, RAIL_LABEL)
      expect(pinned.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
      expect(pinned.rail).toBeLessThanOrEqual(RAIL_MIN + 1)
      expect(pinned.primary).toBeLessThan(wide.primary)

      const pinnedRailBox = await rail(page, RAIL_LABEL).boundingBox()
      expect(pinnedRailBox).not.toBeNull()
      expect(wideRailBox!.width).toBeGreaterThan(pinnedRailBox!.width + 100)
    } finally {
      await request.delete(`/api/reports/${reportId}`)
    }
  })

  test('surface 解禁：内容与 AI chat 满宽，generation 行宽控制不变', async ({ page, request }) => {
    const reportId = await seedReport(request)
    try {
      await page.setViewportSize({ width: 1920, height: 1000 })

      // /edit defaults to AI chat.
      await page.goto(`/edit/${reportId}`)
      const createHeading = page.getByRole('heading', { name: 'Create AI generation session' })
      await expect(createHeading).toBeVisible()

      const aiWidths = await readSurfaceWidths(page)
      expect(aiWidths.main).toBeGreaterThan(1500)
      expect(aiWidths.surface).toBeGreaterThan(1500)
      expect(Math.abs(aiWidths.surface - aiWidths.main)).toBeLessThanOrEqual(1)

      // The generation create panel keeps its own 760px centered measure.
      const createPanelWidth = await createHeading.evaluate(
        (el) => el.parentElement!.parentElement!.getBoundingClientRect().width,
      )
      expect(createPanelWidth).toBeLessThanOrEqual(761)
      expect(createPanelWidth).toBeGreaterThan(700)

      // Content mode shares the uncapped surface.
      await page.getByRole('button', { name: 'Report content' }).click()
      await expect(rail(page, RAIL_LABEL)).toBeVisible()
      const contentWidths = await readSurfaceWidths(page)
      expect(contentWidths.main).toBeGreaterThan(1500)
      expect(contentWidths.surface).toBeGreaterThan(1500)
      expect(Math.abs(contentWidths.surface - contentWidths.main)).toBeLessThanOrEqual(1)
    } finally {
      await request.delete(`/api/reports/${reportId}`)
    }
  })

  test('折叠：≤960 折叠为单栏，主体与右栏竖直堆叠', async ({ page, request }) => {
    const reportId = await seedReport(request)
    try {
      await page.setViewportSize({ width: 1200, height: 900 })
      await openContent(page, reportId)
      await expect.poll(() => readLayoutDisplay(page, RAIL_LABEL)).toBe('grid')

      await page.setViewportSize({ width: 960, height: 900 })
      await expect.poll(() => readLayoutDisplay(page, RAIL_LABEL)).toBe('block')

      const primaryBox = await primary(page).boundingBox()
      const railBox = await rail(page, RAIL_LABEL).boundingBox()
      expect(primaryBox).not.toBeNull()
      expect(railBox).not.toBeNull()
      expect(Math.abs(primaryBox!.width - railBox!.width)).toBeLessThanOrEqual(1)
      expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 1)
    } finally {
      await request.delete(`/api/reports/${reportId}`)
    }
  })

  test('受众切换与终版/原稿/对比/编辑 pane 不受影响', async ({ page, request }) => {
    const reportId = await seedReport(request)
    try {
      await page.setViewportSize({ width: 1920, height: 1000 })
      await openContent(page, reportId, true)

      await expect(page.getByTestId('final-report-body')).toContainText('Body cap rail final')

      await page.getByRole('tab', { name: 'Source draft' }).click()
      await expect(page.getByTestId('source-draft-scroll')).toBeVisible()

      await page.getByRole('tab', { name: 'Compare' }).click()
      await expect(page.getByRole('region', { name: 'Source draft comparison' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Final report comparison' })).toBeVisible()

      await page.getByRole('tab', { name: 'Edit final' }).click()
      await expect(page.getByRole('heading', { name: 'Edit final content' })).toBeVisible()

      // Switching audience re-renders the primary region and keeps the rail.
      await page.getByRole('button', { name: /Leadership/ }).click()
      await expect(primary(page, 'Leadership')).toBeVisible()
      await expect(rail(page, RAIL_LABEL)).toBeVisible()

      await page.getByRole('button', { name: /Personal/ }).click()
      await expect(primary(page, 'Personal')).toBeVisible()
      await expect(page.getByTestId('final-report-body')).toContainText('Body cap rail final')
    } finally {
      await request.delete(`/api/reports/${reportId}`)
    }
  })
})
