import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/lib/db/schema'
import { GET } from './route'
import fs from 'node:fs'
import path from 'node:path'

function createTestDbWithMigrations() {
  const sqlite = new Database(':memory:')

  // Apply all migrations up to 0035
  const migrationsDir = path.join(__dirname, '../../../../drizzle')
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const migrationPath = path.join(migrationsDir, file)
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8')
    const statements = migrationSql.split('--> statement-breakpoint')
    for (const stmt of statements) {
      const trimmed = stmt.trim()
      if (trimmed) {
        sqlite.exec(trimmed)
      }
    }
  }

  return drizzle(sqlite, { schema })
}

describe('/api/plans', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(async () => {
    testDb = createTestDbWithMigrations()
    // Mock getDb to return our test database
    const dbModule = await import('@/lib/db')
    vi.spyOn(dbModule, 'getDb').mockReturnValue(testDb)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const client = (testDb as unknown as { $client?: { close?: () => void } }).$client
    client?.close?.()
  })

  describe('GET', () => {
    it('should return 400 when scope is missing', async () => {
      const request = new Request('http://localhost/api/plans')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('scope')
    })

    it('should return 400 when scope is invalid', async () => {
      const request = new Request('http://localhost/api/plans?scope=invalid')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('scope')
    })

    it('should return empty plan when no plan exists for week scope with date', async () => {
      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).toBeNull()
      expect(data.items).toEqual([])
    })

    it('should return plan with items when plan exists for week scope', async () => {
      const now = new Date()

      // Create a week plan
      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Add items
      testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Task 1',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Task 2',
        status: 'done',
        projectScope: 'personal',
        parentItemId: null,
        deferredFromItemId: null,
        position: 2,
        createdAt: now,
        updatedAt: now,
      }).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).not.toBeNull()
      expect(data.plan.scope).toBe('week')
      expect(data.plan.periodStart).toBe('2026-10-12')
      expect(data.plan.periodEnd).toBe('2026-10-18')
      expect(data.items).toHaveLength(2)
      expect(data.items[0].text).toBe('Task 1')
      expect(data.items[1].text).toBe('Task 2')
    })

    it('should include fulfillment count for each item', async () => {
      const now = new Date()

      // Create a week plan
      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Add items
      testDb.insert(schema.periodPlanItems).values([
        {
          periodPlanId: plan[0].id,
          text: 'Task 1',
          status: 'planned',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'Task 2',
          status: 'done',
          projectScope: 'personal',
          parentItemId: null,
          deferredFromItemId: null,
          position: 2,
          createdAt: now,
          updatedAt: now,
        },
      ]).run()

      // Add events and plan references
      testDb.insert(schema.rawEvents).values([
        { id: 1, eventTime: now, source: 'manual', content: 'Did work %1', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 2, eventTime: now, source: 'manual', content: 'More work %1', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
        { id: 3, eventTime: now, source: 'manual', content: 'Work on %2', metadata: null, category: null, isImportant: false, createdAt: now, updatedAt: now },
      ]).run()

      // Get the actual item IDs
      const items = testDb.select({ id: schema.periodPlanItems.id }).from(schema.periodPlanItems).all()

      testDb.insert(schema.eventPlanReferences).values([
        { eventId: 1, planItemId: items[0].id, createdAt: now },
        { eventId: 2, planItemId: items[0].id, createdAt: now },
        { eventId: 3, planItemId: items[1].id, createdAt: now },
      ]).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(2)
      expect(data.items[0].fulfillmentCount).toBe(2)
      expect(data.items[1].fulfillmentCount).toBe(1)
    })


    it('should query by weekStart and weekEnd for week scope', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plans?scope=week&weekStart=2026-10-12&weekEnd=2026-10-18')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).not.toBeNull()
      expect(data.plan.id).toBe(plan[0].id)
    })

    it('should canonicalize a non-Monday weekStart to the Monday-start week', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Wednesday 2026-10-14 .. Tuesday 2026-10-20 (a raw pair that does not
      // start on Monday) must resolve to the canonical week 10-12 .. 10-18.
      const request = new Request('http://localhost/api/plans?scope=week&weekStart=2026-10-14&weekEnd=2026-10-20')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).not.toBeNull()
      expect(data.plan.id).toBe(plan[0].id)
    })

    it('should return plan for month scope with month parameter', async () => {
      const now = new Date()

      testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).not.toBeNull()
      expect(data.plan.scope).toBe('month')
      expect(data.plan.monthKey).toBe('2026-10')
    })

    it('should return plan for month scope with date parameter', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plans?scope=month&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).not.toBeNull()
      expect(data.plan.id).toBe(plan[0].id)
    })

    it('should sort items by position', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.periodPlanItems).values([
        {
          periodPlanId: plan[0].id,
          text: 'Third',
          status: 'planned',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'First',
          status: 'planned',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'Second',
          status: 'planned',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 2,
          createdAt: now,
          updatedAt: now,
        },
      ]).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(3)
      expect(data.items[0].text).toBe('First')
      expect(data.items[1].text).toBe('Second')
      expect(data.items[2].text).toBe('Third')
    })

    it('should group items high to low, then order by position within each group', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.periodPlanItems).values([
        {
          periodPlanId: plan[0].id,
          text: 'Low first',
          status: 'planned',
          priority: 'low',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'Normal second',
          status: 'planned',
          priority: 'normal',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'High third',
          status: 'planned',
          priority: 'high',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'High first',
          status: 'planned',
          priority: 'high',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'Normal first',
          status: 'planned',
          priority: 'normal',
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items.map((item: { text: string }) => item.text)).toEqual([
        'High first',
        'High third',
        'Normal first',
        'Normal second',
        'Low first',
      ])
    })
    it('should return quadrant flags without letting them affect priority ordering', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.periodPlanItems).values([
        {
          periodPlanId: plan[0].id,
          text: 'Low but flagged',
          status: 'planned',
          priority: 'low',
          isImportant: true,
          isUrgent: true,
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'High unflagged',
          status: 'planned',
          priority: 'high',
          isImportant: false,
          isUrgent: false,
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'Normal flagged',
          status: 'planned',
          priority: 'normal',
          isImportant: true,
          isUrgent: false,
          projectScope: 'work',
          parentItemId: null,
          deferredFromItemId: null,
          position: 3,
          createdAt: now,
          updatedAt: now,
        },
      ]).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items.map((item: { text: string }) => item.text)).toEqual([
        'High unflagged',
        'Normal flagged',
        'Low but flagged',
      ])
      expect(data.items[2].isImportant).toBe(true)
      expect(data.items[2].isUrgent).toBe(true)
      expect(data.items[0].isImportant).toBe(false)
    })

    it('should include the comment count for each item', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const [itemWithComments, itemWithoutComments] = testDb.insert(schema.periodPlanItems).values([
        {
          periodPlanId: plan[0].id,
          text: 'Has context',
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          periodPlanId: plan[0].id,
          text: 'No context',
          position: 2,
          createdAt: now,
          updatedAt: now,
        },
      ]).returning().all()

      testDb.insert(schema.planItemComments).values([
        { planItemId: itemWithComments.id, content: 'first', author: null, createdAt: now },
        { planItemId: itemWithComments.id, content: 'second', author: 'agent', createdAt: now },
      ]).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items[0].text).toBe('Has context')
      expect(data.items[0].commentCount).toBe(2)
      expect(itemWithoutComments).toBeTruthy()
      expect(data.items[1].commentCount).toBe(0)
    })

    it('should aggregate comment counts across the deferral chain', async () => {
      const now = new Date('2026-10-12T00:00:00.000Z')

      const previousPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-11',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const original = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: previousPlan[0].id,
        text: 'Deferred task',
        status: 'deferred',
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const successor = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Deferred task',
        position: 1,
        deferredFromItemId: original[0].id,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.planItemComments).values([
        { planItemId: original[0].id, content: 'ancestor note', author: null, createdAt: now },
        { planItemId: successor[0].id, content: 'successor note', author: null, createdAt: now },
      ]).run()

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(1)
      expect(data.items[0].id).toBe(successor[0].id)
      expect(data.items[0].commentCount).toBe(2)
    })
  })
})
