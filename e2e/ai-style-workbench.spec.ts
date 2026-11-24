import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  BODY_MAX,
  RAIL_MIN,
  expectCollapsed,
  primary,
  rail,
  readTracks,
} from './body-cap-rail-helpers'

const RAIL_LABEL = 'Selected AI style context'
const PRIMARY_LABEL = 'AI style management'

type StyleRecord = {
  id: number
  key: string
  label: string
  systemPrompt: string
}

async function createStyle(request: APIRequestContext, overrides: Partial<StyleRecord> = {}): Promise<StyleRecord> {
  await request.get('/api/prompts/styles')
  const key = `e2e-${randomUUID().slice(0, 8)}`
  const response = await request.post('/api/prompts/styles', {
    data: {
      key,
      label: overrides.label ?? 'E2E style',
      systemPrompt: overrides.systemPrompt ?? 'Complete E2E prompt.\n\nKeep every line.',
      temperature: 0.4,
      detailLevel: 'medium',
      resultOriented: 'medium',
      isDefault: false,
    },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).style
}

async function openStyles(page: Page, id?: number) {
  await page.goto(id ? `/prompts?tab=styles&style=${id}` : '/prompts?tab=styles')
  await expect(primary(page, PRIMARY_LABEL)).toBeVisible()
  await expect(rail(page, RAIL_LABEL)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Complete system prompt', exact: true })).toBeVisible()
}

test('B 工作台：宽屏三列、完整提示词、无效 URL 回退', async ({ page, request }) => {
  const longPrompt = '完整提示词第一行\n\n' + '保留这条指令。\n'.repeat(80) + '最后一行不得截断。'
  const style = await createStyle(request, { label: 'E2E 完整风格', systemPrompt: longPrompt })

  try {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await openStyles(page, style.id)

    const tracks = await readTracks(page, RAIL_LABEL)
    expect(tracks.primary).toBeLessThanOrEqual(BODY_MAX + 1)
    expect(tracks.rail).toBeGreaterThanOrEqual(RAIL_MIN - 1)

    const promptPanel = await page.getByRole('region', { name: 'Complete system prompt', exact: true }).boundingBox()
    const actionsPanel = await page.getByRole('region', { name: 'Change this style' }).boundingBox()
    expect(promptPanel).not.toBeNull()
    expect(actionsPanel).not.toBeNull()
    expect(Math.abs(promptPanel!.x - actionsPanel!.x)).toBeGreaterThan(100)

    await expect(rail(page, RAIL_LABEL).locator('pre')).toHaveText(longPrompt)
    const reader = page.getByRole('region', { name: 'E2E 完整风格 complete system prompt' })
    await expect.poll(() => reader.evaluate((element) => getComputedStyle(element).overflow)).toBe('auto')

    await page.goto('/prompts?tab=styles&style=999999')
    await expect(page).toHaveURL(/style=1(?:&|$)/)
    await expect(page.locator('button[aria-pressed="true"]').first()).toContainText('S1')
  } finally {
    await request.delete(`/api/prompts/styles/${style.id}`)
  }
})

test('列表选择与系统提示词 Tab 使用可恢复 URL', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openStyles(page)

  const rows = page.locator('button[aria-pressed]')
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true')
  await rows.nth(1).click()
  await expect(page).toHaveURL(/tab=styles&style=2$/)
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('tab', { name: 'System prompts' }).click()
  await expect(page).toHaveURL(/tab=system$/)
  await expect(page.getByRole('heading', { name: 'Writing suggestions prompt' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('tab', { name: 'System prompts' })).toHaveAttribute('aria-selected', 'true')
})

test('独立新建和编辑页保存后返回并选中对应风格', async ({ page, request }) => {
  const existing = await createStyle(request, { label: 'E2E 编辑前' })
  let createdId: number | null = null

  try {
    await page.goto(`/prompts/styles/${existing.id}`)
    await expect(page.getByRole('heading', { name: 'Edit AI style', level: 1 })).toHaveCount(1)
    await expect(page.getByLabel('System Prompt')).toHaveValue(existing.systemPrompt)
    await expect(page.getByLabel('Detail level')).toHaveText('Balanced')
    await page.getByLabel('Name').fill('E2E 编辑后')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(`/prompts?tab=styles&style=${existing.id}`)
    await expect(page.getByRole('region', { name: 'Generation record' })).toContainText('E2E 编辑后')

    await page.getByRole('link', { name: 'New style' }).click()
    await expect(page).toHaveURL('/prompts/styles/new')
    await expect(page.getByLabel('Name')).toHaveValue('')
    await expect(page.getByLabel('System Prompt')).toHaveValue('')
    await page.getByLabel('Identifier (key)').fill(`e2e-${randomUUID().slice(0, 8)}`)
    await page.getByLabel('Name').fill('E2E 新建风格')
    await page.getByLabel('System Prompt').fill('新建风格的完整提示词。')
    await page.getByRole('button', { name: 'Create style' }).click()
    await expect(page).toHaveURL(/\/prompts\?tab=styles&style=\d+$/)
    createdId = Number(new URL(page.url()).searchParams.get('style'))
    await expect(page.getByRole('region', { name: 'Generation record' })).toContainText('E2E 新建风格')
  } finally {
    await request.delete(`/api/prompts/styles/${existing.id}`)
    if (createdId) await request.delete(`/api/prompts/styles/${createdId}`)
  }
})

test('未保存保护、普通离开保留草稿、返回恢复与明确放弃', async ({ page, request }) => {
  const style = await createStyle(request, { label: 'E2E 草稿原名' })
  const draftKey = `weekly-reporter.ai-style-draft.edit.${style.id}`
  const editorPath = `/prompts/styles/${style.id}`

  try {
    await page.goto(editorPath)
    await page.getByLabel('Name').fill('E2E 本地草稿')
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) !== null, draftKey)).toBe(true)

    await page.getByRole('link', { name: 'Timeline', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Leave the editor?')
    await page.getByRole('button', { name: 'Leave and keep draft' }).click()
    await expect(page).toHaveURL('/')

    await page.goto(editorPath)
    await expect(page.getByRole('status').filter({ hasText: 'Local draft restored' })).toBeVisible()
    await expect(page.getByLabel('Name')).toHaveValue('E2E 本地草稿')
    await page.getByRole('button', { name: 'Discard draft' }).click()
    await expect(page.getByLabel('Name')).toHaveValue('E2E 草稿原名')
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull()

    await page.getByLabel('Name').fill('E2E 待放弃草稿')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Discard unsaved changes?')
    await page.getByRole('button', { name: 'Discard and leave' }).click()
    await expect(page).toHaveURL(`/prompts?tab=styles&style=${style.id}`)
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull()
  } finally {
    await request.delete(`/api/prompts/styles/${style.id}`)
  }
})

test('≤960px 自然展开提示词，选择后定位详情并可返回列表', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openStyles(page)
  await expectCollapsed(page, RAIL_LABEL, PRIMARY_LABEL)

  const firstLabel = await page.locator('button[aria-pressed]').first().locator('strong').textContent()
  const reader = page.getByRole('region', { name: `${firstLabel} complete system prompt` })
  await expect.poll(() => reader.evaluate((element) => getComputedStyle(element).overflow)).toBe('visible')

  await page.locator('button[aria-pressed]').nth(1).click()
  await expect(page).toHaveURL(/style=2$/)
  const selectedLabel = await page.locator('button[aria-pressed]').nth(1).locator('strong').textContent()
  const selectedReader = page.getByRole('region', { name: `${selectedLabel} complete system prompt` })
  await expect.poll(() => selectedReader.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(0)

  await page.getByRole('link', { name: 'Back to style list' }).click()
  await expect.poll(() => primary(page, PRIMARY_LABEL).evaluate((element) => Math.abs(Math.round(element.getBoundingClientRect().top)))).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
})
