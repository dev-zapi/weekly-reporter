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
  return new Request('http://localhost:6868/api/auth/pats/1', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

function plain(): Request {
  return new Request('http://localhost:6868/api/auth/pats/1', { method: 'DELETE' })
}

describe('/api/auth/pats/[id] DELETE', () => {
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
    const { DELETE } = await import('./route')
    const response = await DELETE(plain(), { params: Promise.resolve({ id: '1' }) })

    expect(response.status).toBe(401)
  })

  it('revokes a PAT and returns 204', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const targetPat = createPat(testDb, 'target-pat')

    const request = new Request(`http://localhost:6868/api/auth/pats/${targetPat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })

    const { DELETE } = await import('./route')
    const response = await DELETE(request, { params: Promise.resolve({ id: String(targetPat.id) }) })

    expect(response.status).toBe(204)

    const rows = testDb.select().from(apiTokens).all()
    const revoked = rows.find((r) => r.id === targetPat.id)
    expect(revoked!.revokedAt).toBeDefined()
  })

  it('returns 404 when PAT not found', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const request = new Request('http://localhost:6868/api/auth/pats/999', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })

    const { DELETE } = await import('./route')
    const response = await DELETE(request, { params: Promise.resolve({ id: '999' }) })

    expect(response.status).toBe(404)
  })

  it('returns 400 when id is invalid', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const request = new Request('http://localhost:6868/api/auth/pats/invalid', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })

    const { DELETE } = await import('./route')
    const response = await DELETE(request, { params: Promise.resolve({ id: 'invalid' }) })

    expect(response.status).toBe(400)
  })

  it('revoked PAT cannot be used (returns 401)', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const targetPat = createPat(testDb, 'target-pat')

    // Revoke the target PAT
    testDb
      .update(apiTokens)
      .set({ revokedAt: Date.now() })
      .where(eq(apiTokens.id, targetPat.id))
      .run()

    // Try to use the revoked PAT
    const request = new Request('http://localhost:6868/api/auth/verify', {
      method: 'GET',
      headers: { Authorization: `Bearer ${targetPat.token}` },
    })

    const { GET } = await import('../../verify/route')
    const response = await GET(request)

    expect(response.status).toBe(401)
  })

  it('records audit for revoke operation', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const targetPat = createPat(testDb, 'target-pat')

    const request = new Request(`http://localhost:6868/api/auth/pats/${targetPat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })

    const { DELETE } = await import('./route')
    await DELETE(request, { params: Promise.resolve({ id: String(targetPat.id) }) })

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].patName).toBe('auth-pat')
    expect(rows[0].status).toBe(204)
    expect(rows[0].outcome).toBe('success')
  })

  it('records audit with outcome=unauthorized when revoked PAT is used', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const targetPat = createPat(testDb, 'target-pat')

    // Revoke the target PAT
    testDb
      .update(apiTokens)
      .set({ revokedAt: Date.now() })
      .where(eq(apiTokens.id, targetPat.id))
      .run()

    // Try to use the revoked PAT
    const request = new Request('http://localhost:6868/api/auth/verify', {
      method: 'GET',
      headers: { Authorization: `Bearer ${targetPat.token}` },
    })

    const { GET } = await import('../../verify/route')
    await GET(request)

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].patName).toBe('target-pat')
    expect(rows[0].status).toBe(401)
    expect(rows[0].outcome).toBe('unauthorized')
  })
})
