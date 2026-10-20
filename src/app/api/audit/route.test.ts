import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { apiAuditLog, apiTokens } from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { createPat } from '@/lib/auth/pat'
import { writeAudit } from '@/lib/auth/audit'

vi.mock('@/lib/db', () => {
  const getDb = vi.fn()
  return { getDb }
})

import { getDb } from '@/lib/db'

const mockedGetDb = getDb as unknown as ReturnType<typeof vi.fn>

const originalAuthDisabled = process.env.WR_AUTH_DISABLED

function bearer(token: string): Request {
  return new Request('http://localhost:6868/api/audit', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

function plain(): Request {
  return new Request('http://localhost:6868/api/audit', { method: 'GET' })
}

describe('/api/audit GET', () => {
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

  it('returns empty array when no audit records exist', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const { GET } = await import('./route')
    const response = await GET(bearer(authPat.token))

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.records).toEqual([])
    expect(data.total).toBe(0)
  })

  it('returns paginated audit records (newest first)', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const pat1 = createPat(testDb, 'pat-1')
    const pat2 = createPat(testDb, 'pat-2')

    // Create some audit records
    const request1 = new Request('http://localhost:6868/api/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${pat1.token}` },
    })
    writeAudit(testDb, request1, 200, 'pat-1')

    const request2 = new Request('http://localhost:6868/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat2.token}` },
    })
    writeAudit(testDb, request2, 201, 'pat-2')

    const { GET } = await import('./route')
    const response = await GET(bearer(authPat.token))

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.records).toHaveLength(2)
    expect(data.total).toBe(2)

    // Newest first
    expect(data.records[0].patName).toBe('pat-2')
    expect(data.records[1].patName).toBe('pat-1')
  })

  it('filters by pat_name', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const pat1 = createPat(testDb, 'pat-1')
    const pat2 = createPat(testDb, 'pat-2')

    const request1 = new Request('http://localhost:6868/api/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${pat1.token}` },
    })
    writeAudit(testDb, request1, 200, 'pat-1')

    const request2 = new Request('http://localhost:6868/api/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${pat2.token}` },
    })
    writeAudit(testDb, request2, 200, 'pat-2')

    const { GET } = await import('./route')
    const url = 'http://localhost:6868/api/audit?patName=pat-1'
    const request = new Request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })
    const response = await GET(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.records).toHaveLength(1)
    expect(data.records[0].patName).toBe('pat-1')
  })

  it('filters by status', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const pat1 = createPat(testDb, 'pat-1')

    const request1 = new Request('http://localhost:6868/api/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${pat1.token}` },
    })
    writeAudit(testDb, request1, 200, 'pat-1')
    writeAudit(testDb, request1, 401, 'pat-1')

    const { GET } = await import('./route')
    const url = 'http://localhost:6868/api/audit?status=401'
    const request = new Request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })
    const response = await GET(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.records).toHaveLength(1)
    expect(data.records[0].status).toBe(401)
  })

  it('filters by outcome', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const pat1 = createPat(testDb, 'pat-1')

    const request1 = new Request('http://localhost:6868/api/events', {
      method: 'GET',
      headers: { Authorization: `Bearer ${pat1.token}` },
    })
    writeAudit(testDb, request1, 200, 'pat-1')
    writeAudit(testDb, request1, 401, 'pat-1')

    const { GET } = await import('./route')
    const url = 'http://localhost:6868/api/audit?outcome=unauthorized'
    const request = new Request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })
    const response = await GET(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.records).toHaveLength(1)
    expect(data.records[0].outcome).toBe('unauthorized')
  })

  it('supports pagination with limit and offset', async () => {
    const authPat = createPat(testDb, 'auth-pat')
    const pat1 = createPat(testDb, 'pat-1')

    // Create 5 audit records
    for (let i = 0; i < 5; i++) {
      const request = new Request('http://localhost:6868/api/events', {
        method: 'GET',
        headers: { Authorization: `Bearer ${pat1.token}` },
      })
      writeAudit(testDb, request, 200, 'pat-1')
    }

    const { GET } = await import('./route')
    const url = 'http://localhost:6868/api/audit?limit=2&offset=1'
    const request = new Request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authPat.token}` },
    })
    const response = await GET(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.records).toHaveLength(2)
    expect(data.total).toBe(5)
  })

  it('records audit for audit query', async () => {
    const authPat = createPat(testDb, 'auth-pat')

    const { GET } = await import('./route')
    await GET(bearer(authPat.token))

    const rows = testDb.select().from(apiAuditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].patName).toBe('auth-pat')
    expect(rows[0].status).toBe(200)
    expect(rows[0].outcome).toBe('success')
  })
})
