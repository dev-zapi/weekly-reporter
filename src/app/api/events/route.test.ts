import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GET, POST } from './route'
import { syncEventTags } from '@/lib/tags'

vi.mock('@/lib/tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tags')>()
  return { ...actual, syncEventTags: vi.fn() }
})

vi.mock('@/lib/references', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/references')>()
  return { ...actual, syncEventReferences: vi.fn() }
})

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
  get: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: mocks.select,
    insert: mocks.insert,
    transaction: mocks.transaction,
    query: {
      collectSources: {
        findMany: mocks.findMany,
      },
    },
  }),
}))

describe('/api/events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('GET', () => {
    it('should return events ordered by eventTime descending', async () => {
      const mockEvents = [
        {
          id: 2,
          eventTime: new Date('2024-01-10T10:00:00'),
          source: 'github',
          content: 'Later event',
          status: 'pending',
          isImportant: false,
        },
        {
          id: 1,
          eventTime: new Date('2024-01-08T10:00:00'),
          source: 'manual',
          content: 'Earlier event',
          status: 'pending',
          isImportant: true,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEvents)
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockDynamicResult = { orderBy: mockOrderBy, limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, orderBy: mockOrderBy, limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(Array.isArray(data.events)).toBe(true)
      expect(data.events).toHaveLength(2)
    })

    it('should return events within date range', async () => {
      const mockEvents = [
        {
          id: 1,
          eventTime: new Date('2024-01-10T10:00:00'),
          source: 'github',
          content: 'Event in range',
          status: 'pending',
          isImportant: false,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEvents)
      const mockWhere = vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit })
      const mockDynamicResult = { where: mockWhere, orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, where: mockWhere, orderBy: vi.fn(), limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events?weekStart=2024-01-08&weekEnd=2024-01-14')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toHaveLength(1)
      expect(mockWhere).toHaveBeenCalled()
    })

    it('should handle database error', async () => {
      const mockLimit = vi.fn().mockRejectedValue(new Error('Database error'))
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockDynamicResult = { orderBy: mockOrderBy, limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, orderBy: mockOrderBy, limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Failed to fetch events')
      expect(data.code).toBe('FETCH_ERROR')
    })

    it('should handle combined filters', async () => {
      const mockEvents = [
        {
          id: 1,
          eventTime: new Date('2024-01-10T10:00:00'),
          source: 'github',
          content: 'Filtered event',
          status: 'processed',
          isImportant: true,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEvents)
      const mockWhere = vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit })
      const mockDynamicResult = { where: mockWhere, orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, where: mockWhere, orderBy: vi.fn(), limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events?weekStart=2024-01-08&weekEnd=2024-01-14&status=processed')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toHaveLength(1)
    })

    it('should filter events by date parameter', async () => {
      const mockEvents = [
        {
          id: 1,
          eventTime: new Date('2024-01-10T10:00:00'),
          source: 'manual',
          content: 'Event on specific date',
          status: 'pending',
          isImportant: false,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEvents)
      const mockWhere = vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit })
      const mockDynamicResult = { where: mockWhere, orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, where: mockWhere, orderBy: vi.fn(), limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events?date=2024-01-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toHaveLength(1)
      expect(mockWhere).toHaveBeenCalled()
    })

    it('should combine date filter with other filters', async () => {
      const mockEvents = [
        {
          id: 1,
          eventTime: new Date('2024-01-10T10:00:00'),
          source: 'manual',
          content: 'Filtered event on date',
          status: 'pending',
          isImportant: false,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEvents)
      const mockWhere = vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit })
      const mockDynamicResult = { where: mockWhere, orderBy: vi.fn().mockReturnValue({ limit: mockLimit }), limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, where: mockWhere, orderBy: vi.fn(), limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events?date=2024-01-10&source=manual')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toHaveLength(1)
    })

    it('should ignore invalid date parameter', async () => {
      const mockEvents = [
        {
          id: 1,
          eventTime: new Date('2024-01-10T10:00:00'),
          source: 'manual',
          content: 'Event',
          status: 'pending',
          isImportant: false,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEvents)
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockDynamicResult = { orderBy: mockOrderBy, limit: mockLimit }
      const mockDynamic = vi.fn().mockReturnValue(mockDynamicResult)
      const mockFromResult = { $dynamic: mockDynamic, orderBy: mockOrderBy, limit: mockLimit }
      const mockFrom = vi.fn().mockReturnValue(mockFromResult)
      mocks.select.mockReturnValue({ from: mockFrom })

      mocks.findMany.mockResolvedValue([])

      const request = new Request('http://localhost/api/events?date=invalid-date')
      const response = await GET(request)

      expect(response.status).toBe(200)
    })
  })

  describe('POST', () => {
    it('should create new memo event and sync tags', async () => {
      const mockEvent = {
        id: 1,
        content: '完成评审 #成果 #工作',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      mocks.get.mockReturnValue(mockEvent)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          insert: mocks.insert.mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({ get: mocks.get }),
            }),
          }),
        }
        return cb(tx)
      })

      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '完成评审 #成果 #工作',
          eventTime: '2024-01-10T10:00:00',
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.content).toBe('完成评审 #成果 #工作')
      expect(data.source).toBe('manual')
      expect(mocks.insert).toHaveBeenCalled()
      expect(mocks.transaction).toHaveBeenCalled()
      expect(syncEventTags).toHaveBeenCalledWith(expect.anything(), 1, ['成果', '工作'])
    })

    it('should reject empty content', async () => {
      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Content is required')
      expect(data.code).toBe('INVALID_CONTENT')
    })

    it('should reject whitespace-only content', async () => {
      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Content is required')
      expect(data.code).toBe('INVALID_CONTENT')
    })

    it('should reject missing content', async () => {
      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventTime: '2024-01-10T10:00:00' }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Content is required')
      expect(data.code).toBe('INVALID_CONTENT')
    })

    it('should reject invalid eventTime format', async () => {
      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test event',
          eventTime: 'invalid-date',
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid event time')
      expect(data.code).toBe('INVALID_EVENT_TIME')
    })

    it('should accept valid eventTime', async () => {
      const mockEvent = {
        id: 1,
        content: 'Test event',
        eventTime: new Date('2024-01-15T14:30:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      mocks.get.mockReturnValue(mockEvent)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          insert: mocks.insert.mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({ get: mocks.get }),
            }),
          }),
        }
        return cb(tx)
      })

      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test event',
          eventTime: '2024-01-15T14:30:00',
        }),
      })
      const response = await POST(request)

      expect(response.status).toBe(201)
      expect(mocks.insert).toHaveBeenCalled()
    })

    it('should accept content without eventTime', async () => {
      const mockEvent = {
        id: 1,
        content: 'Test event',
        eventTime: new Date(),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mocks.get.mockReturnValue(mockEvent)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          insert: mocks.insert.mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({ get: mocks.get }),
            }),
          }),
        }
        return cb(tx)
      })

      const request = new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test event' }),
      })
      const response = await POST(request)

      expect(response.status).toBe(201)
      expect(mocks.insert).toHaveBeenCalled()
    })
  })
})
