import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as schema from '@/lib/db/schema'
import { GET } from './route'
import { createTestDbWithMigrations } from '@/test/db'

describe('/api/plan-items/[id]/fulfillment', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(async () => {
    testDb = createTestDbWithMigrations()
    const dbModule = await import('@/lib/db')
    vi.spyOn(dbModule, 'getDb').mockReturnValue(testDb)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const client = (testDb as unknown as { $client?: { close?: () => void } }).$client
    client?.close?.()
  })

  describe('GET', () => {
    it('should return 404 when item does not exist', async () => {
      const request = new Request('http://localhost/api/plan-items/999/fulfillment')
      const params = Promise.resolve({ id: '999' })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toContain('not found')
    })

    it('should return empty array when item has no fulfilling events', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const item = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Test item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id + '/fulfillment')
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toEqual([])
    })

    it('should return fulfilling events for the item', async () => {
      const now = new Date()
      const eventTime1 = new Date('2026-10-15T10:00:00Z')
      const eventTime2 = new Date('2026-10-16T11:00:00Z')

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const item = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Test item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Insert events
      testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: eventTime1, source: 'manual', content: 'Did work %' + item[0].id, metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 2, eventTime: eventTime2, source: 'github', content: 'More work %' + item[0].id, metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      // Insert plan references
      testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: item[0].id, createdAt: now },
        { eventId: 2, planItemId: item[0].id, createdAt: now },
      ]).run()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id + '/fulfillment')
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toHaveLength(2)
      expect(data.events[0]).toMatchObject({
        id: 1,
        content: 'Did work %' + item[0].id,
        eventTime: eventTime1.toISOString(),
        isManual: true,
      })
      expect(data.events[1]).toMatchObject({
        id: 2,
        content: 'More work %' + item[0].id,
        eventTime: eventTime2.toISOString(),
        isManual: false,
      })
    })

    it('should aggregate events from deferral chain ancestors', async () => {
      const now = new Date()
      const eventTime1 = new Date('2026-10-05T10:00:00Z')
      const eventTime2 = new Date('2026-10-12T11:00:00Z')
      const eventTime3 = new Date('2026-10-19T12:00:00Z')

      // Create plans for different weeks
      await testDb.insert(schema.periodPlans).values([
        { id: 1, scope: 'week', periodStart: '2026-10-05', periodEnd: '2026-10-11', monthKey: null, createdAt: now, updatedAt: now },
        { id: 2, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null, createdAt: now, updatedAt: now },
        { id: 3, scope: 'week', periodStart: '2026-10-19', periodEnd: '2026-10-25', monthKey: null, createdAt: now, updatedAt: now },
      ]).run()

      // Create items with deferral chain: 30 -> 20 -> 10
      await testDb.insert(schema.periodPlanItems).values([
        { id: 10, periodPlanId: 1, text: 'Original', status: 'deferred', projectScope: 'work', parentItemId: null, deferredFromItemId: null, position: 1, createdAt: now, updatedAt: now },
        { id: 20, periodPlanId: 2, text: 'Deferred once', status: 'deferred', projectScope: 'work', parentItemId: null, deferredFromItemId: 10, position: 1, createdAt: now, updatedAt: now },
        { id: 30, periodPlanId: 3, text: 'Deferred twice', status: 'planned', projectScope: 'work', parentItemId: null, deferredFromItemId: 20, position: 1, createdAt: now, updatedAt: now },
      ]).run()

      // Insert events referencing different items in the chain
      await testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: eventTime1, source: 'manual', content: 'Work on %10', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 2, eventTime: eventTime2, source: 'manual', content: 'Work on %20', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 3, eventTime: eventTime3, source: 'manual', content: 'Work on %30', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      // Insert plan references
      await testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: 10, createdAt: now },
        { eventId: 2, planItemId: 20, createdAt: now },
        { eventId: 3, planItemId: 30, createdAt: now },
      ]).run()

      // Query fulfillment for item 30 - should include events from 10, 20, and 30
      const request = new Request('http://localhost/api/plan-items/30/fulfillment')
      const params = Promise.resolve({ id: '30' })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.events).toHaveLength(3)

      // Events should be sorted by eventTime
      expect(data.events[0].id).toBe(1)
      expect(data.events[1].id).toBe(2)
      expect(data.events[2].id).toBe(3)
    })
  })
})
