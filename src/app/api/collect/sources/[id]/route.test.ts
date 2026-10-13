import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PUT } from './route'

vi.mock('@/lib/db', () => {
  const mockReturning = vi.fn()
  const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning })
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere })
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet })
  const mockFindFirst = vi.fn()
  const mockFindMany = vi.fn()

  return {
    getDb: vi.fn(() => ({
      query: { collectSources: { findFirst: mockFindFirst, findMany: mockFindMany } },
      update: mockUpdate,
    })),
    __mocks: { mockFindFirst, mockFindMany, mockUpdate, mockSet, mockReturning },
  }
})

const existing = {
  id: 1,
  type: 'git-local',
  name: 'old-name',
  config: { owner: '/tmp/alpha', authorEmails: ['dev@example.com'] },
  enabled: true,
}

const bodyOf = (extra: Record<string, unknown> = {}) => ({
  type: 'git-local',
  name: 'new-name',
  projectScope: 'personal',
  config: { owner: '/tmp/alpha', authorEmails: ['dev@example.com'] },
  ...extra,
})

const putRequest = (body: unknown) => [new Request('http://localhost/api/collect/sources/1', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), { params: Promise.resolve({ id: '1' }) }] as const

describe('/api/collect/sources/[id] PUT', () => {
  const getMocks = async () => {
    const mod = (await import('@/lib/db')) as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }
    return mod.__mocks
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => vi.restoreAllMocks())

  it('persists top-level aliases into config.aliases (regression: they were silently dropped)', async () => {
    const { mockFindFirst, mockFindMany, mockSet, mockReturning } = await getMocks()
    mockFindFirst.mockResolvedValueOnce(existing)
    mockFindMany.mockResolvedValueOnce([]) // no conflicting aliases
    mockReturning.mockResolvedValueOnce([{ ...existing, name: 'new-name' }])

    const response = await PUT(...putRequest(bodyOf({ aliases: ['ax'] })))
    expect(response.status).toBe(200)

    const updated = mockSet.mock.calls[0][0]
    expect(updated.config.aliases).toEqual(['ax'])
  })

  it('full-replace semantics: aliases absent from the body clears the stored ones', async () => {
    const { mockFindFirst, mockSet, mockReturning } = await getMocks()
    mockFindFirst.mockResolvedValueOnce({ ...existing, config: { ...existing.config, aliases: ['old-alias'] } })
    mockReturning.mockResolvedValueOnce([{ ...existing, name: 'new-name' }])

    const response = await PUT(...putRequest(bodyOf()))
    expect(response.status).toBe(200)

    const updated = mockSet.mock.calls[0][0]
    expect(updated.config.aliases).toBeUndefined()
  })

  it('rejects an alias owned by another source, excluding its own (DUPLICATE_ALIAS)', async () => {
    const { mockFindFirst, mockFindMany, mockUpdate } = await getMocks()
    mockFindFirst.mockResolvedValueOnce({ ...existing, config: { ...existing.config, aliases: ['ax'] } })
    mockFindMany.mockResolvedValueOnce([
      { id: 1, name: 'self', config: { aliases: ['ax'] } },        // own alias — allowed
      { id: 9, name: 'other', config: { aliases: ['taken'] } },    // someone else's — rejected
    ])

    const response = await PUT(...putRequest(bodyOf({ aliases: ['ax', 'taken'] })))
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.code).toBe('DUPLICATE_ALIAS')
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
