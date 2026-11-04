import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { GET, POST } from './route'

vi.mock('@/lib/db', () => {
  const mockReturning = vi.fn()
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning })
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues })
  const mockFindMany = vi.fn()
  const mockWhere = vi.fn().mockResolvedValue([{ count: 0 }])
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom })

  return {
    getDb: vi.fn(() => ({
      query: { collectSources: { findMany: mockFindMany } },
      insert: mockInsert,
      select: mockSelect,
    })),
    __mocks: { mockFindMany, mockInsert, mockValues, mockReturning, mockSelect, mockWhere },
  }
})

const baseBody = {
  type: 'git-local',
  name: 'alpha',
  projectScope: 'personal',
  config: { owner: '/tmp/alpha', authorEmails: ['dev@example.com'] },
}

const requestWith = (body: unknown) => new Request('http://localhost/api/collect/sources', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('/api/collect/sources GET', () => {
  const getMocks = async () => {
    const mod = (await import('@/lib/db')) as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }
    return mod.__mocks
  }

  const requestWithQuery = (query: string) =>
    new Request(`http://localhost/api/collect/sources?${query}`)

  const renderedWhere = (mockFindMany: ReturnType<typeof vi.fn>) => {
    const where = mockFindMany.mock.calls[0][0].where
    return new SQLiteSyncDialect().sqlToQuery(where.getSQL())
  }

  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('matches the stored `failed` status when the Failed filter sends `failure`', async () => {
    const { mockFindMany } = await getMocks()
    mockFindMany.mockResolvedValueOnce([])

    const response = await GET(requestWithQuery('syncStatus=failure'))
    expect(response.status).toBe(200)

    const query = renderedWhere(mockFindMany)
    expect(query.params).toContain('failed')
    expect(query.sql).toContain(' in ')
  })

  it('matches the stored `failed` status when the client already uses `failed`', async () => {
    const { mockFindMany } = await getMocks()
    mockFindMany.mockResolvedValueOnce([])

    await GET(requestWithQuery('syncStatus=failed'))

    const query = renderedWhere(mockFindMany)
    expect(query.params).toContain('failed')
  })

  it('only matches `success` for the success filter', async () => {
    const { mockFindMany } = await getMocks()
    mockFindMany.mockResolvedValueOnce([])

    await GET(requestWithQuery('syncStatus=success'))

    const query = renderedWhere(mockFindMany)
    expect(query.params).toEqual(['success'])
  })
})

describe('/api/collect/sources POST', () => {
  const getMocks = async () => {
    const mod = (await import('@/lib/db')) as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }
    return mod.__mocks
  }

  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('persists top-level aliases into config.aliases (regression: they were silently dropped)', async () => {
    const { mockFindMany, mockValues, mockReturning } = await getMocks()
    mockFindMany.mockResolvedValueOnce([]) // no existing aliases
    mockReturning.mockResolvedValueOnce([{ id: 1, name: 'alpha', config: {} }])

    const response = await POST(requestWith({ ...baseBody, aliases: ['ax'] }))
    expect(response.status).toBe(201)

    const inserted = mockValues.mock.calls[0][0]
    expect(inserted.config.aliases).toEqual(['ax'])
  })

  it('omits the aliases key entirely when the body has none', async () => {
    const { mockValues, mockReturning } = await getMocks()
    mockReturning.mockResolvedValueOnce([{ id: 2, name: 'beta', config: {} }])

    const response = await POST(requestWith(baseBody))
    expect(response.status).toBe(201)

    const inserted = mockValues.mock.calls[0][0]
    expect(inserted.config.aliases).toBeUndefined()
  })

  it('rejects an alias already used by another source (DUPLICATE_ALIAS)', async () => {
    const { mockFindMany, mockInsert } = await getMocks()
    mockFindMany.mockResolvedValueOnce([{ id: 9, name: 'other', config: { aliases: ['ax'] } }])

    const response = await POST(requestWith({ ...baseBody, aliases: ['ax'] }))
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.code).toBe('DUPLICATE_ALIAS')
    expect(mockInsert).not.toHaveBeenCalled()
  })
})
