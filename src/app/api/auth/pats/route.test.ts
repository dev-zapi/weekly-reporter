import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiAuditLog, apiTokens } from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { createPat } from '@/lib/auth/pat'

vi.mock('@/lib/db', () => {
  const getDb = vi.fn()
  return { getDb }
})

import { getDb } from '@/lib/db'

const mockedGetDb = getDb as unknown as ReturnType<typeof vi.fn>

const originalAuthDisabled = process.env.WR_AUTH_DISABLED

function bearer(token: string): Request {
  return new Request('http://localhost:6868/api/auth/pats', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

function plain(): Request {
  return new Request('http://localhost:6868/api/auth/pats', { method: 'GET' })
}

describe('/api/auth/pats GET', () => {
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

  it('returns 401 when not authenticated', async () => {
    const { GET } = await import('./route')
    const response = await GET(plain())

    expect(response.status).toBe(401)
  })

  it('returns empty array when no PATs exist', async () => {
    // Use password auth to avoid creating a PAT
    vi.doMock('@/lib/auth/password', () => ({
      readStartupPassword: vi.fn(() => 'test-password'),
    }))
    vi.resetModules()

    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-password' },
    })

    const { GET } = await import('./route')
    const response = await GET(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.pats).toEqual([])
  })

  it('returns list of PAT metadata without token_hash', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    createPat(testDb, 'pat-1')
    createPat(testDb, 'pat-2')

    const { GET } = await import('./route')
    const response = await GET(bearer(authPat.token))

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.pats).toHaveLength(3) // includes auth-pat

    const pat1 = data.pats.find((p: any) => p.name === 'pat-1')
    expect(pat1).toBeDefined()
    expect(pat1.id).toBeDefined()
    expect(pat1.name).toBe('pat-1')
    expect(pat1.prefix).toBeDefined()
    expect(pat1.createdAt).toBeDefined()
    expect(pat1.token_hash).toBeUndefined()
    expect(pat1.tokenHash).toBeUndefined()
    expect(pat1.token).toBeUndefined()
  })

  it('includes revoked_at, expires_at, last_used_at in metadata', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const pat = createPat(testDb, 'test-pat', { expiresAt: Date.now() + 86400000 })

    // Touch the PAT to set last_used_at
    testDb
      .update(apiTokens)
      .set({ lastUsedAt: Date.now() })
      .where(eq(apiTokens.id, pat.id))
      .run()

    const { GET } = await import('./route')
    const response = await GET(bearer(authPat.token))
    const data = await response.json()

    const retrievedPat = data.pats.find((p: any) => p.name === 'test-pat')
    expect(retrievedPat.lastUsedAt).toBeDefined()
    expect(retrievedPat.expiresAt).toBeDefined()
    expect(retrievedPat.revokedAt).toBeNull()
  })

  it('records audit for PAT mode', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    createPat(testDb, 'pat-1')

    const { GET } = await import('./route')
    await GET(bearer(authPat.token))

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].patName).toBe('auth-pat')
    expect(rows[0].status).toBe(200)
    expect(rows[0].outcome).toBe('success')
  })
})

describe('/api/auth/pats POST', () => {
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

  it('returns 401 when not authenticated', async () => {
    const { POST } = await import('./route')
    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-pat' }),
    })

    const response = await POST(request)
    expect(response.status).toBe(401)
  })

  it('creates a PAT and returns plaintext token once', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const { POST } = await import('./route')
    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authPat.token}`,
      },
      body: JSON.stringify({ name: 'new-pat' }),
    })

    const response = await POST(request)
    expect(response.status).toBe(201)

    const data = await response.json()
    expect(data.id).toBeDefined()
    expect(data.name).toBe('new-pat')
    expect(data.token).toBeDefined()
    expect(data.token.startsWith('wrp_')).toBe(true)
    expect(data.createdAt).toBeDefined()
  })

  it('stores token hash in database, not plaintext', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const { POST } = await import('./route')
    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authPat.token}`,
      },
      body: JSON.stringify({ name: 'new-pat' }),
    })

    const response = await POST(request)
    const data = await response.json()

    const rows = testDb.select().from(apiTokens).all()
    const newPat = rows.find((r) => r.name === 'new-pat')
    expect(newPat).toBeDefined()
    expect(newPat!.tokenHash).toBeDefined()
    expect(newPat!.tokenHash).not.toBe(data.token) // stored hash != plaintext
    expect(newPat!.tokenHash.length).toBe(64) // SHA-256 hex = 64 chars
  })

  it('returns 400 when name is missing', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const { POST } = await import('./route')
    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authPat.token}`,
      },
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)

    const data = await response.json()
    expect(data.error).toContain('name')
  })

  it('respects optional expiresAt', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const expiresAt = Date.now() + 86400000 // 1 day from now

    const { POST } = await import('./route')
    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authPat.token}`,
      },
      body: JSON.stringify({ name: 'expiring-pat', expiresAt }),
    })

    const response = await POST(request)
    expect(response.status).toBe(201)

    const rows = testDb.select().from(apiTokens).all()
    const newPat = rows.find((r) => r.name === 'expiring-pat')
    expect(newPat!.expiresAt).toBe(expiresAt)
  })

  it('records audit for PAT creation', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const { POST } = await import('./route')
    const request = new Request('http://localhost:6868/api/auth/pats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authPat.token}`,
      },
      body: JSON.stringify({ name: 'new-pat' }),
    })

    await POST(request)

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].patName).toBe('auth-pat')
    expect(rows[0].status).toBe(201)
    expect(rows[0].outcome).toBe('success')
  })
})
