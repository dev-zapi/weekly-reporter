import { expect, test } from '@playwright/test'
import { readStartupPassword } from './auth-env'

/**
 * Auth-enabled Playwright suite.
 *
 * 与默认 `playwright.config.ts` 互补：默认套件关闭认证（`WR_AUTH_DISABLED=1`），
 * 这里认证开启。`e2e/auth.config.ts` 用独立的 XDG 目录启动服务，启动密码由
 * `auth-env.preparePassword()` 在 config 加载时按 `password.ts` 同样的算法预
 * 生成到隔离的 auth.json 中。服务端 `ensureStartupPassword` 启动后读到已有
 * 密码会跳过生成。测试通过 `readStartupPassword()` 读取同一文件，模拟「刚
 * 登录的浏览器」或「新拿到的 PAT」场景。
 */

function bearer(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } }
}

interface AuditRecord {
  id: number
  patName: string | null
  apiPath: string
  status: number
  outcome: 'success' | 'unauthorized'
}

async function fetchAudit(
  request: import('@playwright/test').APIRequestContext,
  password: string,
  query: string,
): Promise<AuditRecord[]> {
  const res = await request.get(`/api/audit?${query}`, bearer(password))
  expect(res.ok(), `audit fetch failed: ${res.status()}`).toBe(true)
  const body = (await res.json()) as { records: AuditRecord[] }
  return body.records
}

async function createPat(
  request: import('@playwright/test').APIRequestContext,
  password: string,
  name: string,
): Promise<{ id: number; name: string; token: string }> {
  const res = await request.post('/api/auth/pats', {
    headers: { Authorization: `Bearer ${password}` },
    data: { name },
  })
  expect(res.status(), `create PAT: ${await res.text()}`).toBe(201)
  return res.json()
}

test.describe('认证开启时的 API 行为', () => {
  test('无凭据访问 /api/events 返回 401', async ({ request }) => {
    const res = await request.get('/api/events')
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('Unauthorized')
  })

  test('错误密码访问 /api/events 返回 401', async ({ request }) => {
    const res = await request.get('/api/events', bearer('not-the-correct-password'))
    expect(res.status()).toBe(401)
  })

  test('正确启动密码访问 /api/events 返回 200', async ({ request }) => {
    const password = readStartupPassword()
    const res = await request.get('/api/events', bearer(password))
    expect(res.status()).toBe(200)
  })

  test('PAT 调用 200 且审计表出现一行 success', async ({ request }) => {
    const password = readStartupPassword()
    const patName = `e2e-pat-${Date.now()}`
    const pat = await createPat(request, password, patName)
    expect(pat.token).toMatch(/^wrp_/)

    const used = await request.get('/api/events', bearer(pat.token))
    expect(used.status()).toBe(200)

    const records = await fetchAudit(request, password, `patName=${encodeURIComponent(patName)}`)
    expect(records.some(r => r.patName === patName && r.status === 200 && r.outcome === 'success')).toBe(true)
  })

  test('吊销 PAT 后调用返回 401 且审计记录 unauthorized', async ({ request }) => {
    const password = readStartupPassword()
    const patName = `e2e-revoked-${Date.now()}`
    const pat = await createPat(request, password, patName)

    // 吊销前能用
    const before = await request.get('/api/events', bearer(pat.token))
    expect(before.status()).toBe(200)

    // 吊销
    const revoked = await request.delete(`/api/auth/pats/${pat.id}`, bearer(password))
    expect(revoked.status()).toBe(204)

    // 吊销后 401
    const afterRevoke = await request.get('/api/events', bearer(pat.token))
    expect(afterRevoke.status()).toBe(401)

    const records = await fetchAudit(
      request,
      password,
      `patName=${encodeURIComponent(patName)}&status=401`,
    )
    expect(records.some(r => r.patName === patName && r.status === 401 && r.outcome === 'unauthorized')).toBe(true)
  })

  test('UI：未登录访问 / 跳转到 /login；登录后 timeline 加载', async ({ page }) => {
    const password = readStartupPassword()
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
    // 表单元素可见
    await expect(page.getByPlaceholder('Startup password')).toBeVisible()

    const input = page.getByPlaceholder('Startup password')
    await input.click()
    await input.pressSequentially(password, { delay: 5 })
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeEnabled()
    await page.getByRole('button', { name: /Sign in/ }).click()

    // 登录成功后 router.replace 回到 /
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })
    // Filter by source 面板是 timeline 页的标志性元素
    await expect(page.getByText('Filter by source')).toBeVisible({ timeout: 15_000 })
  })
})
