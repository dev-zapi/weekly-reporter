import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as schema from '@/lib/db/schema'
import { getFulfillmentChain, getFulfillmentCount, getFulfillingEvents } from './fulfillment'
import * as dbModule from '@/lib/db'
import { createTestDbWithMigrations } from '@/test/db'

describe('fulfillment', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(async () => {
    testDb = createTestDbWithMigrations()
    vi.spyOn(dbModule, 'getDb').mockReturnValue(testDb)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const client = (testDb as unknown as { $client?: { close?: () => void } }).$client
    client?.close?.()
  })

  describe('getFulfillmentChain', () => {
    it('returns the item itself when no deferral ancestors exist', async () => {
      // Insert a plan and item with no deferredFromItemId
      const now = new Date()
      await testDb.insert(schema.periodPlans).values({
        id: 1,
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).run()

      await testDb.insert(schema.periodPlanItems).values({
        id: 10,
        periodPlanId: 1,
        text: 'Item 10',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      const chain = await getFulfillmentChain(10)

      expect(chain).toEqual([10])
    })

    it('walks the deferral chain to collect ancestors', async () => {
      const now = new Date()

      // Insert plans
      await testDb.insert(schema.periodPlans).values([
        { id: 1, scope: 'week', periodStart: '2026-10-05', periodEnd: '2026-10-11', monthKey: null, createdAt: now, updatedAt: now },
        { id: 2, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null, createdAt: now, updatedAt: now },
        { id: 3, scope: 'week', periodStart: '2026-10-19', periodEnd: '2026-10-25', monthKey: null, createdAt: now, updatedAt: now },
      ]).run()

      // Item 10 (original)
      await testDb.insert(schema.periodPlanItems).values({
        id: 10, periodPlanId: 1, text: 'Original', status: 'deferred', projectScope: 'work',
        parentItemId: null, deferredFromItemId: null, position: 1, createdAt: now, updatedAt: now,
      }).run()

      // Item 20 (deferred from 10)
      await testDb.insert(schema.periodPlanItems).values({
        id: 20, periodPlanId: 2, text: 'Deferred once', status: 'deferred', projectScope: 'work',
        parentItemId: null, deferredFromItemId: 10, position: 1, createdAt: now, updatedAt: now,
      }).run()

      // Item 30 (deferred from 20)
      await testDb.insert(schema.periodPlanItems).values({
        id: 30, periodPlanId: 3, text: 'Deferred twice', status: 'planned', projectScope: 'work',
        parentItemId: null, deferredFromItemId: 20, position: 1, createdAt: now, updatedAt: now,
      }).run()

      const chain = await getFulfillmentChain(30)

      // Should return [30, 20, 10] - the item and its ancestors
      expect(chain).toEqual([30, 20, 10])
    })

    it('returns empty array when item does not exist', async () => {
      const chain = await getFulfillmentChain(999)

      expect(chain).toEqual([])
    })
  })

  describe('getFulfillmentCount', () => {
    it('counts events referencing the item and its ancestors', async () => {
      const now = new Date()

      // Insert plans and items (chain: 30 -> 20 -> 10)
      await testDb.insert(schema.periodPlans).values([
        { id: 1, scope: 'week', periodStart: '2026-10-05', periodEnd: '2026-10-11', monthKey: null, createdAt: now, updatedAt: now },
        { id: 2, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null, createdAt: now, updatedAt: now },
        { id: 3, scope: 'week', periodStart: '2026-10-19', periodEnd: '2026-10-25', monthKey: null, createdAt: now, updatedAt: now },
      ]).run()

      await testDb.insert(schema.periodPlanItems).values([
        { id: 10, periodPlanId: 1, text: 'Original', status: 'deferred', projectScope: 'work', parentItemId: null, deferredFromItemId: null, position: 1, createdAt: now, updatedAt: now },
        { id: 20, periodPlanId: 2, text: 'Deferred once', status: 'deferred', projectScope: 'work', parentItemId: null, deferredFromItemId: 10, position: 1, createdAt: now, updatedAt: now },
        { id: 30, periodPlanId: 3, text: 'Deferred twice', status: 'planned', projectScope: 'work', parentItemId: null, deferredFromItemId: 20, position: 1, createdAt: now, updatedAt: now },
      ]).run()

      // Insert events
      await testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: now, source: 'manual', content: 'Did work %10', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 2, eventTime: now, source: 'manual', content: 'More work %20', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 3, eventTime: now, source: 'manual', content: 'Even more %30', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 4, eventTime: now, source: 'github', content: 'Other %10', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      // Insert plan references
      await testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: 10, createdAt: now },
        { eventId: 2, planItemId: 20, createdAt: now },
        { eventId: 3, planItemId: 30, createdAt: now },
        { eventId: 4, planItemId: 10, createdAt: now },
      ]).run()

      const count = await getFulfillmentCount(30)

      // Item 30's chain is [30, 20, 10], so it should count all 4 events
      expect(count).toBe(4)
    })

    it('returns 0 when item does not exist', async () => {
      const count = await getFulfillmentCount(999)
      expect(count).toBe(0)
    })

    it('counts an event that references two items in the chain only once', async () => {
      const now = new Date()

      await testDb.insert(schema.periodPlans).values([
        { id: 1, scope: 'week', periodStart: '2026-10-05', periodEnd: '2026-10-11', monthKey: null, createdAt: now, updatedAt: now },
        { id: 2, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null, createdAt: now, updatedAt: now },
      ]).run()

      await testDb.insert(schema.periodPlanItems).values([
        { id: 10, periodPlanId: 1, text: 'Original', status: 'deferred', projectScope: 'work', parentItemId: null, deferredFromItemId: null, position: 1, createdAt: now, updatedAt: now },
        { id: 20, periodPlanId: 2, text: 'Carried', status: 'planned', projectScope: 'work', parentItemId: null, deferredFromItemId: 10, position: 1, createdAt: now, updatedAt: now },
      ]).run()

      // A single event cites both items in the same deferral chain.
      await testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: now, source: 'manual', content: 'Did %10 and %20', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      await testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: 10, createdAt: now },
        { eventId: 1, planItemId: 20, createdAt: now },
      ]).run()

      expect(await getFulfillmentCount(20)).toBe(1)
    })
  })

  describe('getFulfillingEvents', () => {
    it('returns events referencing the item and its ancestors with required fields', async () => {
      const now = new Date()
      const eventTime1 = new Date('2026-10-15T10:00:00Z')
      const eventTime2 = new Date('2026-10-16T11:00:00Z')

      // Insert plan and items
      await testDb.insert(schema.periodPlans).values({
        id: 1, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null, createdAt: now, updatedAt: now,
      }).run()

      await testDb.insert(schema.periodPlanItems).values({
        id: 10, periodPlanId: 1, text: 'Item 10', status: 'planned', projectScope: 'work',
        parentItemId: null, deferredFromItemId: null, position: 1, createdAt: now, updatedAt: now,
      }).run()

      // Insert events
      await testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: eventTime1, source: 'manual', content: 'Did work %10', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 2, eventTime: eventTime2, source: 'github', content: 'More work %10', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      // Insert plan references
      await testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: 10, createdAt: now },
        { eventId: 2, planItemId: 10, createdAt: now },
      ]).run()

      const events = await getFulfillingEvents(10)

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        id: 1,
        content: 'Did work %10',
        eventTime: eventTime1,
        isManual: true,
      })
      expect(events[1]).toMatchObject({
        id: 2,
        content: 'More work %10',
        eventTime: eventTime2,
        isManual: false,
      })
    })

    it('returns empty array when item does not exist', async () => {
      const events = await getFulfillingEvents(999)
      expect(events).toEqual([])
    })

    it('lists an event that references two items in the chain only once', async () => {
      const now = new Date()

      await testDb.insert(schema.periodPlans).values([
        { id: 1, scope: 'week', periodStart: '2026-10-05', periodEnd: '2026-10-11', monthKey: null, createdAt: now, updatedAt: now },
        { id: 2, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null, createdAt: now, updatedAt: now },
      ]).run()

      await testDb.insert(schema.periodPlanItems).values([
        { id: 10, periodPlanId: 1, text: 'Original', status: 'deferred', projectScope: 'work', parentItemId: null, deferredFromItemId: null, position: 1, createdAt: now, updatedAt: now },
        { id: 20, periodPlanId: 2, text: 'Carried', status: 'planned', projectScope: 'work', parentItemId: null, deferredFromItemId: 10, position: 1, createdAt: now, updatedAt: now },
      ]).run()

      await testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: now, source: 'manual', content: 'Did %10 and %20', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      await testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: 10, createdAt: now },
        { eventId: 1, planItemId: 20, createdAt: now },
      ]).run()

      const events = await getFulfillingEvents(20)
      expect(events).toHaveLength(1)
      expect(events[0].id).toBe(1)
    })
  })
})
