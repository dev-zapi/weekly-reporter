import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GET } from './route'

vi.mock('@/lib/db', () => {
  let mockChain: ReturnType<typeof createMockChain> | null = null

  const createMockChain = () => {
    const mockOrderBy = vi.fn()
    const mockWhereResult = { orderBy: mockOrderBy }
    const mockWhere = vi.fn().mockReturnValue(mockWhereResult)
    const mockFromResult = { where: mockWhere }
    const mockFrom = vi.fn().mockReturnValue(mockFromResult)
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom })

    return {
      select: mockSelect,
      from: mockFrom,
      where: mockWhere,
      orderBy: mockOrderBy,
    }
  }

  return {
    getDb: vi.fn(() => {
      if (!mockChain) {
        mockChain = createMockChain()
      }
      return mockChain
    }),
  }
})

describe('/api/events/heatmap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function mockQueryResult(rows: Array<{ eventTime: Date }>) {
    const { getDb } = await import('@/lib/db')
    const db = getDb() as unknown as { orderBy: ReturnType<typeof vi.fn> }
    db.orderBy.mockResolvedValueOnce(rows)
  }

  it('should return heatmap data grouped by day', async () => {
    await mockQueryResult([
      { eventTime: new Date('2026-07-14T10:00:00') },
      { eventTime: new Date('2026-07-14T14:00:00') },
      { eventTime: new Date('2026-07-13T09:00:00') },
    ])

    const response = await GET(new Request('http://localhost/api/events/heatmap'))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toHaveProperty('data')
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.data).toHaveLength(2)
    expect(data.data[0]).toEqual({ date: '2026-07-14', count: 2 })
    expect(data.data[1]).toEqual({ date: '2026-07-13', count: 1 })
  })

  it('should return date as YYYY-MM-DD string', async () => {
    await mockQueryResult([
      { eventTime: new Date('2026-07-14T10:00:00') },
    ])

    const response = await GET(new Request('http://localhost/api/events/heatmap'))
    const data = await response.json()

    expect(data.data[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('should aggregate multiple events on the same day', async () => {
    await mockQueryResult([
      { eventTime: new Date('2026-07-14T08:00:00') },
      { eventTime: new Date('2026-07-14T12:00:00') },
      { eventTime: new Date('2026-07-14T18:00:00') },
    ])

    const response = await GET(new Request('http://localhost/api/events/heatmap'))
    const data = await response.json()

    expect(data.data).toHaveLength(1)
    expect(data.data[0]).toEqual({ date: '2026-07-14', count: 3 })
  })

  it('should return empty array when no events exist', async () => {
    await mockQueryResult([])

    const response = await GET(new Request('http://localhost/api/events/heatmap'))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.data).toEqual([])
  })

  it('should only include dates with events (no zero-fill)', async () => {
    await mockQueryResult([
      { eventTime: new Date('2026-07-14T10:00:00') },
      { eventTime: new Date('2026-07-10T09:00:00') },
    ])

    const response = await GET(new Request('http://localhost/api/events/heatmap'))
    const data = await response.json()

    expect(data.data).toHaveLength(2)
    expect(data.data.every((d: { count: number }) => d.count > 0)).toBe(true)
    // Sorted descending by date
    expect(data.data[0].date).toBe('2026-07-14')
    expect(data.data[1].date).toBe('2026-07-10')
  })

  it('should handle database errors gracefully', async () => {
    const { getDb } = await import('@/lib/db')
    const db = getDb() as unknown as { orderBy: ReturnType<typeof vi.fn> }
    db.orderBy.mockRejectedValueOnce(new Error('Database error'))

    const response = await GET(new Request('http://localhost/api/events/heatmap'))
    const data = await response.json()

    expect(response.status).toBe(500)
    expect(data.error).toBe('Failed to fetch heatmap data')
    expect(data.code).toBe('FETCH_ERROR')
  })

  it('should accept custom days parameter', async () => {
    await mockQueryResult([])

    const request = new Request('http://localhost/api/events/heatmap?days=30')
    const response = await GET(request)

    expect(response.status).toBe(200)
  })

  it('should clamp days parameter to max 730', async () => {
    await mockQueryResult([])

    const request = new Request('http://localhost/api/events/heatmap?days=9999')
    const response = await GET(request)

    expect(response.status).toBe(200)
  })
})
