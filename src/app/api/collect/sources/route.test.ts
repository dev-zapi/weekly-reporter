import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { POST } from './route'

vi.mock('@/lib/db', () => {
  const mockReturning = vi.fn()
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning })
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues })
  const mockFindMany = vi.fn()

  return {
    getDb: vi.fn(() => ({
      query: { collectSources: { findMany: mockFindMany } },
      insert: mockInsert,
    })),
    __mocks: { mockFindMany, mockInsert, mockValues, mockReturning },
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
