import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { apiAuditLog } from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { createPat } from '@/lib/auth/pat'

vi.mock('@/lib/db', () => {
  const getDb = vi.fn()
  return { getDb }
})

import { getDb } from '@/lib/db'

const mockedGetDb = getDb as unknown as ReturnType<typeof vi.fn>

/** setup.ts 默认把认证关掉；本文件要测开启后的行为，故先摘掉，测完还原 */
const originalAuthDisabled = process.env.WR_AUTH_DISABLED

function bearer(token: string): Request {
  return new Request('http://localhost:6868/api/auth/verify', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

function plain(): Request {
  return new Request('http://localhost:6868/api/auth/verify', { method: 'GET' })
}

describe('/api/auth/verify', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(() => {
    testDb = createTestDbWithMigrations()
    mockedGetDb.mockReturnValue(testDb)
    delete process.env.WR_AUTH_DISABLED
    vi.resetModules()
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (originalAuthDisabled === undefined) {
      delete process.env.WR_AUTH_DISABLED
    } else {
      process.env.WR_AUTH_DISABLED = originalAuthDisabled
    }
  })

  it('returns 401 when no Authorization header is provided', async () => {
    const { GET } = await import('./route')
    const response = await GET(plain())

    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data).toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when Authorization header is invalid', async () => {
    const { GET } = await import('./route')
    const response = await GET(bearer('invalid-token'))

    expect(response.status).toBe(401)
  })

  it('returns 200 with mode=password when startup password is valid', async () => {
    vi.doMock('@/lib/auth/password', () => ({
      readStartupPassword: vi.fn(() => 'correct-password'),
    }))
    vi.resetModules()

    const { GET } = await import('./route')
    const response = await GET(bearer('correct-password'))

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ ok: true, mode: 'password' })
  })

  it('returns 200 with mode=pat when PAT is valid', async () => {
    const created = createPat(testDb, 'test-pat')

    const { GET } = await import('./route')
    const response = await GET(bearer(created.token))

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ ok: true, mode: 'pat' })
  })

  it('does not record audit for password mode', async () => {
    vi.doMock('@/lib/auth/password', () => ({
      readStartupPassword: vi.fn(() => 'correct-password'),
    }))
    vi.resetModules()

    const { GET } = await import('./route')
    await GET(bearer('correct-password'))

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(0)
  })

  it('records audit for pat mode', async () => {
    const created = createPat(testDb, 'test-pat')

    const { GET } = await import('./route')
    await GET(bearer(created.token))

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].patName).toBe('test-pat')
    expect(rows[0].status).toBe(200)
    expect(rows[0].outcome).toBe('success')
  })

  it('returns 200 when auth is disabled', async () => {
    process.env.WR_AUTH_DISABLED = '1'
    vi.resetModules()

    const { GET } = await import('./route')
    const response = await GET(plain())

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ ok: true, mode: 'disabled' })
  })
})
