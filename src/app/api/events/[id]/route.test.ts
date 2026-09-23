import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PUT, DELETE } from './route'
import { NextRequest } from 'next/server'
import { syncEventTags } from '@/lib/tags'

vi.mock('@/lib/tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tags')>()
  return { ...actual, syncEventTags: vi.fn() }
})

vi.mock('@/lib/references', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/references')>()
  return { ...actual, syncEventReferences: vi.fn(), deleteEventReferences: vi.fn() }
})

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  returning: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: mocks.select,
    update: mocks.update,
    delete: mocks.delete,
    transaction: mocks.transaction,
  }),
}))

describe('/api/events/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('PUT', () => {
    it('should update event content and sync tags', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const updatedEvent = {
        ...existingEvent,
        content: '更新后的内容 #成果',
        isImportant: true,
        updatedAt: new Date('2024-01-11T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      mocks.get.mockReturnValue(updatedEvent)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockReturnValue({ get: mocks.get }),
              }),
            }),
          }),
        }
        return cb(tx)
      })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '更新后的内容 #成果',
          isImportant: true,
        }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.content).toBe('更新后的内容 #成果')
      expect(data.isImportant).toBe(true)
      expect(mocks.select).toHaveBeenCalled()
      expect(mocks.transaction).toHaveBeenCalled()
      expect(syncEventTags).toHaveBeenCalledWith(expect.anything(), 1, ['成果'])
    })

    it('should update event time without syncing tags (no content change)', async () => {
      const existingEvent = {
        id: 1,
        content: 'Test event',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const updatedEvent = {
        ...existingEvent,
        eventTime: new Date('2024-01-15T10:00:00'),
        updatedAt: new Date('2024-01-11T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      mocks.get.mockReturnValue(updatedEvent)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockReturnValue({ get: mocks.get }),
              }),
            }),
          }),
        }
        return cb(tx)
      })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventTime: '2024-01-15T10:00:00',
        }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })

      expect(response.status).toBe(200)
      expect(mocks.transaction).toHaveBeenCalled()
      expect(syncEventTags).not.toHaveBeenCalled()
    })

    it('should return 404 for non-existent event', async () => {
      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/999', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test' }),
      })
      const params = Promise.resolve({ id: '999' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toBe('Event not found')
    })

    it('should reject empty content', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Content is required')
      expect(data.code).toBe('INVALID_CONTENT')
    })

    it('should reject whitespace-only content', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Content is required')
      expect(data.code).toBe('INVALID_CONTENT')
    })

    it('should reject invalid eventTime format', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventTime: 'invalid-date' }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid event time')
      expect(data.code).toBe('INVALID_EVENT_TIME')
    })

    it('should reject non-boolean isImportant', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isImportant: 'yes' }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('isImportant must be a boolean')
      expect(data.code).toBe('INVALID_IS_IMPORTANT')
    })

    it('should reject invalid request body', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not-json',
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid request body')
      expect(data.code).toBe('INVALID_BODY')
    })

    it('should accept boolean false for isImportant without syncing tags', async () => {
      const existingEvent = {
        id: 1,
        content: 'Original content',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: true,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const updatedEvent = {
        ...existingEvent,
        isImportant: false,
        updatedAt: new Date('2024-01-11T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      mocks.get.mockReturnValue(updatedEvent)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockReturnValue({ get: mocks.get }),
              }),
            }),
          }),
        }
        return cb(tx)
      })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isImportant: false }),
      })
      const params = Promise.resolve({ id: '1' })
      const response = await PUT(request, { params })

      expect(response.status).toBe(200)
      expect(mocks.transaction).toHaveBeenCalled()
      expect(syncEventTags).not.toHaveBeenCalled()
    })
  })

  describe('DELETE', () => {
    it('should delete manual event with tag cascade', async () => {
      const existingEvent = {
        id: 1,
        content: 'Test event',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'manual',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const mockRun = vi.fn()
      const mockDeleteWhere = vi.fn().mockReturnValue({ run: mockRun })
      const deleteFn = vi.fn().mockReturnValue({ where: mockDeleteWhere })

      mocks.delete.mockImplementation(deleteFn)
      mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
        const tx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ run: mockRun }),
          }),
        }
        return cb(tx)
      })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: '1' })
      const response = await DELETE(request, { params })

      expect(response.status).toBe(204)
      expect(mocks.select).toHaveBeenCalled()
      expect(mocks.transaction).toHaveBeenCalled()
    })

    it('should reject deletion of non-manual event', async () => {
      const existingEvent = {
        id: 1,
        content: 'GitHub event',
        eventTime: new Date('2024-01-10T10:00:00'),
        source: 'github',
        sectionType: 'routine',
        status: 'pending',
        isImportant: false,
        createdAt: new Date('2024-01-10T10:00:00'),
        updatedAt: new Date('2024-01-10T10:00:00'),
      }

      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([existingEvent])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/1', {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: '1' })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Cannot delete non-manual event')
    })

    it('should return 404 for non-existent event', async () => {
      const orderBy = vi.fn()
      const limit = vi.fn().mockResolvedValue([])
      const whereChain = { orderBy, limit }
      const where = vi.fn().mockReturnValue(whereChain)
      const fromChain = { where }
      const from = vi.fn().mockReturnValue(fromChain)
      mocks.select.mockReturnValue({ from })

      const request = new NextRequest('http://localhost/api/events/999', {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: '999' })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toBe('Event not found')
    })
  })
})
