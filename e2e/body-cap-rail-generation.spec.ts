import { test, expect, type Page } from './generation-fixtures'
import { SCRIPTED_AI_URL, scriptedInstruction } from './scripted-ai'

/**
 * body-cap rail 宽度契约 — AI 会话（ticket #150）。
 *
 * 会话激活时 `.sessionGrid` 迁移到 WorkbenchLayout：宽窗口下会话流主体封顶，
 * 提案面板吃掉余量并保持至少 380px；提案正文仍然 72ch。961–1100 保持两栏，
 * ≤960 折叠单栏。断言只读计算样式与包围盒，不碰组件内部结构。
 */

const BODY_MAX = 1000
const RAIL_MIN = 380
const RAIL_LABEL = 'Read-only proposal review'
const PRIMARY_LABEL = 'Generation session'

function rail(page: Page) {
  return page.getByRole('complementary', { name: RAIL_LABEL })
}

function primary(page: Page) {
  return page.getByRole('region', { name: PRIMARY_LABEL })
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

/** Document measure vs. an independent 72ch box rendered in its own font. */
async function readDocumentMeasure(page: Page) {
  return page.getByTestId('proposal-document').evaluate((el) => {
    const style = getComputedStyle(el)
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.display = 'block'
    probe.style.width = '72ch'
    probe.style.fontFamily = style.fontFamily
    probe.style.fontSize = style.fontSize
    probe.style.fontWeight = style.fontWeight
    document.body.appendChild(probe)
    const ch72 = probe.getBoundingClientRect().width
    probe.remove()
    return {
      maxWidth: Number.parseFloat(style.maxWidth),
      ch72,
      width: el.getBoundingClientRect().width,
    }
  })
}

async function seedProposalSession(
  request: import('@playwright/test').APIRequestContext,
  reportId: number,
  scenario: string,
): Promise<number> {
  const created = await request.post(`/api/reports/${reportId}/generation-sessions`, {
    data: { variant: 'personal', templateId: 'official-general' },
  })
  expect(created.status()).toBe(201)
  const session = await created.json() as { id: number }

  const content = `# 本周完成\n\n- 已完成：${scenario} current source fact\n\n## 下周计划\n- 整理公开评审结论`
  const stream = await request.post(`/api/reports/${reportId}/generation-sessions/${session.id}/turns`, {
    data: {
      message: scriptedInstruction('生成待评审的完整提案', {
        steps: [{
          kind: 'stream',
          reasoning: '已核对原稿事实。',
          text: '已准备只读候选终版。',
          toolCalls: [{
            name: 'propose_final_report',
            arguments: { content, summary: ['整理本周完成内容', '补充下周计划'] },
          }],
        }],
      }),
    },
  })
  expect(stream.ok()).toBeTruthy()
  return session.id
}

async function openAiSession(page: Page, reportId: number) {
  await page.goto(`/edit/${reportId}`)
  await page.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect(primary(page)).toBeVisible()
  await expect(rail(page)).toBeVisible()
  await expect(rail(page).getByText('Pending review')).toBeVisible({ timeout: 30_000 })
}

test.describe('body-cap rail — AI generation session', () => {
  test('封顶：≥1450 第一轨 ≤1000，提案面板 ≥380 且随视口增长', async ({ page, request, reportId, scenario }) => {
    await request.put('/api/settings/ai', {
      data: { protocol: 'openai-compatible', apiUrl: SCRIPTED_AI_URL, apiKey: 'e2e-scripted', model: 'e2e-scripted' },
    })
    await seedProposalSession(request, reportId, scenario)

    await page.setViewportSize({ width: 1750, height: 1000 })
    await openAiSession(page, reportId)

    const wide = await readTracks(page)
    expect(wide.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(wide.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const wideRail = await rail(page).boundingBox()
    expect(wideRail).not.toBeNull()
    expect(wideRail!.width).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    await page.setViewportSize({ width: 1450, height: 1000 })
    await expect
      .poll(async () => (await readTracks(page)).rail)
      .toBeGreaterThanOrEqual(RAIL_MIN - 1)
    const narrowRail = await rail(page).boundingBox()
    expect(narrowRail).not.toBeNull()

    // Above the cap, widening the window hands the extra width to the rail.
    expect(wideRail!.width).toBeGreaterThan(narrowRail!.width + 20)
  })

  test('断点：961–1100 维持两栏，≤960 折叠单栏', async ({ page, request, reportId, scenario }) => {
    await request.put('/api/settings/ai', {
      data: { protocol: 'openai-compatible', apiUrl: SCRIPTED_AI_URL, apiKey: 'e2e-scripted', model: 'e2e-scripted' },
    })
    await seedProposalSession(request, reportId, scenario)

    await page.setViewportSize({ width: 1100, height: 900 })
    await openAiSession(page, reportId)

    for (const width of [1100, 1000, 961]) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(async () => (await readTracks(page)).rail)
        .toBeGreaterThanOrEqual(RAIL_MIN - 1)
      const tracks = await readTracks(page)
      // Two tracks survive the whole 961–1100 band (the old 1100px fold is gone).
      expect(tracks.primary).toBeGreaterThan(0)
      expect(tracks.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)
      expect(await readLayoutDisplay(page)).toBe('grid')
    }

    await page.setViewportSize({ width: 960, height: 900 })
    await expect.poll(() => readLayoutDisplay(page)).toBe('block')

    const primaryBox = await primary(page).boundingBox()
    const railBox = await rail(page).boundingBox()
    expect(primaryBox).not.toBeNull()
    expect(railBox).not.toBeNull()

    // Single column: both spans share the body width and the proposal rail
    // follows the chat section vertically.
    expect(Math.abs(primaryBox!.width - railBox!.width)).toBeLessThanOrEqual(1)
    expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 1)
  })

  test('提案文档行宽保持 72ch，不随提案栏变宽而拉伸', async ({ page, request, reportId, scenario }) => {
    await request.put('/api/settings/ai', {
      data: { protocol: 'openai-compatible', apiUrl: SCRIPTED_AI_URL, apiKey: 'e2e-scripted', model: 'e2e-scripted' },
    })
    await seedProposalSession(request, reportId, scenario)

    await page.setViewportSize({ width: 1450, height: 1000 })
    await openAiSession(page, reportId)
    const narrow = await readDocumentMeasure(page)
    expect(narrow.maxWidth).toBeGreaterThan(0)
    expect(Math.abs(narrow.maxWidth - narrow.ch72)).toBeLessThanOrEqual(2)
    expect(narrow.width).toBeLessThanOrEqual(narrow.maxWidth + 1)

    await page.setViewportSize({ width: 1750, height: 1000 })
    await expect.poll(async () => (await readTracks(page)).rail).toBeGreaterThan(RAIL_MIN + 20)
    const wide = await readDocumentMeasure(page)
    // The measure is unchanged while the surrounding rail grew.
    expect(Math.abs(wide.maxWidth - narrow.maxWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(wide.maxWidth - wide.ch72)).toBeLessThanOrEqual(2)
    expect(wide.width).toBeLessThanOrEqual(wide.maxWidth + 1)
  })
})
