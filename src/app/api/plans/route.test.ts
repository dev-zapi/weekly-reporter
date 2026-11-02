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

  describe('month-scope aggregation (月度回看)', () => {
    const now = new Date('2026-10-15T00:00:00.000Z')

    function createMonthPlan(db: typeof testDb, monthKey = '2026-10') {
      const [year, month] = monthKey.split('-').map(Number)
      const periodStart = `${monthKey}-01`
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
      const periodEnd = `${monthKey}-${String(lastDay).padStart(2, '0')}`
      return db.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart,
        periodEnd,
        monthKey,
        createdAt: now,
        updatedAt: now,
      }).returning().all()[0]
    }

    function createWeekPlan(db: typeof testDb, periodStart: string, periodEnd: string) {
      return db.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart,
        periodEnd,
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()[0]
    }

    function createItem(db: typeof testDb, planId: number, values: {
      text: string
      parentItemId?: number | null
      deferredFromItemId?: number | null
      status?: 'planned' | 'in_progress' | 'done' | 'cancelled' | 'deferred'
      projectScope?: 'work' | 'personal'
      priority?: 'high' | 'normal' | 'low'
      isImportant?: boolean
      isUrgent?: boolean
      position?: number
    }) {
      return db.insert(schema.periodPlanItems).values({
        periodPlanId: planId,
        text: values.text,
        status: values.status ?? 'planned',
        projectScope: values.projectScope ?? 'work',
        priority: values.priority ?? 'normal',
        isImportant: values.isImportant ?? false,
        isUrgent: values.isUrgent ?? false,
        parentItemId: values.parentItemId ?? null,
        deferredFromItemId: values.deferredFromItemId ?? null,
        position: values.position ?? 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()[0]
    }

    function createEvents(db: typeof testDb, itemIds: number[]) {
      const eventIds = itemIds.map((_, index) => index + 1)
      if (itemIds.length === 0) return
      db.insert(schema.rawEvents).values(
        eventIds.map((id) => ({
          id,
          eventTime: now,
          source: 'manual',
          content: `Work %${id}`,
          metadata: null,
          category: null,
          isImportant: false,
          createdAt: now,
          updatedAt: now,
        }))
      ).run()
      db.insert(schema.eventPlanReferences).values(
        itemIds.map((planItemId, index) => ({
          eventId: eventIds[index],
          planItemId,
          createdAt: now,
        }))
      ).run()
    }

    it('returns attached week items with week attribution and per-child counts, excluding unparented items', async () => {
      const monthPlan = createMonthPlan(testDb)
      const goal = createItem(testDb, monthPlan.id, { text: 'Goal' })
      const week3 = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      const week5 = createWeekPlan(testDb, '2026-10-26', '2026-11-01')

      const childA = createItem(testDb, week3.id, {
        text: 'Child A',
        parentItemId: goal.id,
        status: 'done',
        projectScope: 'work',
        priority: 'high',
        isImportant: true,
        position: 2,
      })
      const childB = createItem(testDb, week5.id, {
        text: 'Child B',
        parentItemId: goal.id,
        status: 'in_progress',
        projectScope: 'personal',
        priority: 'low',
        isUrgent: true,
        position: 1,
      })
      const orphan = createItem(testDb, week3.id, { text: 'Orphan', position: 3 })

      createEvents(testDb, [childA.id, childA.id, childB.id, orphan.id])
      testDb.insert(schema.planItemComments).values({
        planItemId: childA.id,
        content: 'context',
        author: null,
        createdAt: now,
      }).run()

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(1)
      const [item] = data.items
      expect(item.id).toBe(goal.id)
      expect(item.childItems).toHaveLength(2)

      const byId = new Map<number, Record<string, unknown>>(
        item.childItems.map((child: Record<string, unknown>) => [child.id as number, child])
      )
      const a = byId.get(childA.id)!
      expect(a).toMatchObject({
        id: childA.id,
        text: 'Child A',
        status: 'done',
        projectScope: 'work',
        priority: 'high',
        isImportant: true,
        isUrgent: false,
        weekPeriodStart: '2026-10-12',
        weekPeriodEnd: '2026-10-18',
        fulfillmentCount: 2,
        commentCount: 1,
      })
      const b = byId.get(childB.id)!
      expect(b).toMatchObject({
        id: childB.id,
        text: 'Child B',
        status: 'in_progress',
        projectScope: 'personal',
        priority: 'low',
        isImportant: false,
        isUrgent: true,
        weekPeriodStart: '2026-10-26',
        weekPeriodEnd: '2026-11-01',
        fulfillmentCount: 1,
        commentCount: 0,
      })
      expect(byId.has(orphan.id)).toBe(false)
    })

    it('separates direct evidence from indirect evidence in the composed count', async () => {
      const monthPlan = createMonthPlan(testDb)
      const goal = createItem(testDb, monthPlan.id, { text: 'Goal' })
      const week3 = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      const childA = createItem(testDb, week3.id, { text: 'Child A', parentItemId: goal.id })
      const childB = createItem(testDb, week3.id, { text: 'Child B', parentItemId: goal.id, position: 2 })

      // Two events cite the monthly item directly, two cite child A, one cites child B.
      createEvents(testDb, [goal.id, goal.id, childA.id, childA.id, childB.id])

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(1)
      expect(data.items[0].directFulfillmentCount).toBe(2)
      expect(data.items[0].indirectFulfillmentCount).toBe(3)
      expect(data.items[0].fulfillmentCount).toBe(5)
    })

    it("mirrors week-item deferral by aggregating the ancestor month item's children", async () => {
      const septemberPlan = createMonthPlan(testDb, '2026-09')
      const ancestor = createItem(testDb, septemberPlan.id, { text: 'Ancestor goal' })
      // A week starting in September belongs to September, not October.
      const septemberWeek = createWeekPlan(testDb, '2026-09-07', '2026-09-13')
      const ancestorChild = createItem(testDb, septemberWeek.id, {
        text: 'Ancestor child',
        parentItemId: ancestor.id,
      })

      const octoberPlan = createMonthPlan(testDb, '2026-10')
      const successor = createItem(testDb, octoberPlan.id, {
        text: 'Ancestor goal',
        deferredFromItemId: ancestor.id,
      })
      const octoberWeek = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      const successorChild = createItem(testDb, octoberWeek.id, {
        text: 'Successor child',
        parentItemId: successor.id,
      })

      // One event cites each month item directly, two cite the ancestor's week
      // child, one cites the successor's week child.
      createEvents(testDb, [ancestor.id, successor.id, ancestorChild.id, ancestorChild.id, successorChild.id])

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(1)
      const [item] = data.items
      expect(item.id).toBe(successor.id)
      // Direct aggregates the deferral chain (successor + ancestor).
      expect(item.directFulfillmentCount).toBe(2)
      // Indirect aggregates the successor's own children plus the ancestor's.
      expect(item.indirectFulfillmentCount).toBe(3)
      expect(item.fulfillmentCount).toBe(5)
      // Only the successor's own children are rendered in the tree.
      expect(item.childItems).toHaveLength(1)
      expect(item.childItems[0].id).toBe(successorChild.id)
    })

    it('aggregates ancestor children through nested month and child deferral chains', async () => {
      // Month deferral chain: August root -> September ancestor -> October successor.
      const augustPlan = createMonthPlan(testDb, '2026-08')
      const ancestorRoot = createItem(testDb, augustPlan.id, {
        text: 'Root goal',
        status: 'deferred',
      })
      const septemberPlan = createMonthPlan(testDb, '2026-09')
      const ancestor = createItem(testDb, septemberPlan.id, {
        text: 'Root goal',
        status: 'deferred',
        deferredFromItemId: ancestorRoot.id,
      })
      const octoberPlan = createMonthPlan(testDb, '2026-10')
      const successor = createItem(testDb, octoberPlan.id, {
        text: 'Root goal',
        deferredFromItemId: ancestor.id,
      })

      // Each ancestor keeps its own attached child; nothing migrates.
      const augustWeek = createWeekPlan(testDb, '2026-08-10', '2026-08-16')
      const rootChild = createItem(testDb, augustWeek.id, {
        text: 'Root child',
        parentItemId: ancestorRoot.id,
      })
      const septemberWeek = createWeekPlan(testDb, '2026-09-07', '2026-09-13')
      // The September child has its own week deferral predecessor.
      const predecessorWeek = createWeekPlan(testDb, '2026-08-31', '2026-09-06')
      const childPredecessor = createItem(testDb, predecessorWeek.id, {
        text: 'Ancestor child',
      })
      const ancestorChild = createItem(testDb, septemberWeek.id, {
        text: 'Ancestor child',
        parentItemId: ancestor.id,
        deferredFromItemId: childPredecessor.id,
      })
      const octoberWeek = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      const successorChild = createItem(testDb, octoberWeek.id, {
        text: 'Successor child',
        parentItemId: successor.id,
      })

      createEvents(testDb, [
        ancestorRoot.id,
        ancestor.id,
        successor.id,
        rootChild.id,
        ancestorChild.id,
        ancestorChild.id,
        childPredecessor.id,
        successorChild.id,
      ])

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items).toHaveLength(1)
      const [item] = data.items
      expect(item.id).toBe(successor.id)
      // Direct: the successor and every ancestor month item in its chain.
      expect(item.directFulfillmentCount).toBe(3)
      // Indirect: one event via the root's child, three via the ancestor child
      // (two own + one from its week deferral predecessor), one via its own
      // child.
      expect(item.indirectFulfillmentCount).toBe(5)
      expect(item.fulfillmentCount).toBe(8)
      expect(item.childItems).toHaveLength(1)
      expect(item.childItems[0].id).toBe(successorChild.id)
    })

    it('keeps the deferred month item and its children in place', async () => {
      const septemberPlan = createMonthPlan(testDb, '2026-09')
      const original = createItem(testDb, septemberPlan.id, {
        text: 'Kept goal',
        status: 'deferred',
      })
      const septemberWeek = createWeekPlan(testDb, '2026-09-07', '2026-09-13')
      const child = createItem(testDb, septemberWeek.id, {
        text: 'Still attached',
        parentItemId: original.id,
      })
      const octoberPlan = createMonthPlan(testDb, '2026-10')
      const successor = createItem(testDb, octoberPlan.id, {
        text: 'Kept goal',
        deferredFromItemId: original.id,
      })
      createEvents(testDb, [child.id, child.id])

      const septemberResponse = await GET(
        new Request('http://localhost/api/plans?scope=month&month=2026-09')
      )
      const septemberData = await septemberResponse.json()

      expect(septemberResponse.status).toBe(200)
      expect(septemberData.items).toHaveLength(1)
      const [originalFromResponse] = septemberData.items
      expect(originalFromResponse.id).toBe(original.id)
      // The original still owns its attached child after the deferral.
      expect(originalFromResponse.childItems).toHaveLength(1)
      expect(originalFromResponse.childItems[0].id).toBe(child.id)
      expect(originalFromResponse.indirectFulfillmentCount).toBe(2)

      const octoberResponse = await GET(
        new Request('http://localhost/api/plans?scope=month&month=2026-10')
      )
      const octoberData = await octoberResponse.json()

      expect(octoberResponse.status).toBe(200)
      expect(octoberData.items).toHaveLength(1)
      const [successorFromResponse] = octoberData.items
      expect(successorFromResponse.id).toBe(successor.id)
      // Nothing migrated: the successor has no children of its own, but it
      // still carries the ancestor's child's evidence.
      expect(successorFromResponse.childItems).toEqual([])
      expect(successorFromResponse.directFulfillmentCount).toBe(0)
      expect(successorFromResponse.indirectFulfillmentCount).toBe(2)
      expect(successorFromResponse.fulfillmentCount).toBe(2)
    })

    it('groups attach candidates by week, scoped to the month and covering unparented items only', async () => {
      const monthPlan = createMonthPlan(testDb)
      const goal = createItem(testDb, monthPlan.id, { text: 'Goal' })

      // A week starting in September belongs to September.
      const septemberWeek = createWeekPlan(testDb, '2026-09-28', '2026-10-04')
      createItem(testDb, septemberWeek.id, { text: 'September orphan' })

      const week3 = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      createItem(testDb, week3.id, { text: 'Normal late', priority: 'normal', position: 5 })
      createItem(testDb, week3.id, { text: 'High late', priority: 'high', position: 1 })
      createItem(testDb, week3.id, { text: 'Attached item', parentItemId: goal.id, position: 2 })

      const week5 = createWeekPlan(testDb, '2026-10-26', '2026-11-01')
      createItem(testDb, week5.id, { text: 'Low week5', priority: 'low', position: 1 })

      // A week starting in November must never appear in October's candidates.
      const novemberWeek = createWeekPlan(testDb, '2026-11-02', '2026-11-08')
      createItem(testDb, novemberWeek.id, { text: 'November orphan' })

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.attachCandidates).toHaveLength(2)
      expect(data.attachCandidates.map((week: { periodStart: string }) => week.periodStart)).toEqual([
        '2026-10-12',
        '2026-10-26',
      ])
      expect(data.attachCandidates[0]).toMatchObject({
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
      })
      expect(data.attachCandidates[0].items.map((item: { text: string }) => item.text)).toEqual([
        'High late',
        'Normal late',
      ])
      expect(data.attachCandidates[1].items.map((item: { text: string }) => item.text)).toEqual([
        'Low week5',
      ])
    })

    it('orders monthly items and their children by priority group then position', async () => {
      const monthPlan = createMonthPlan(testDb)
      createItem(testDb, monthPlan.id, { text: 'Normal p1', priority: 'normal', position: 1 })
      createItem(testDb, monthPlan.id, { text: 'High p3', priority: 'high', position: 3 })
      createItem(testDb, monthPlan.id, { text: 'Low p1', priority: 'low', position: 1 })
      const goal = createItem(testDb, monthPlan.id, { text: 'High p1', priority: 'high', position: 1 })

      const week3 = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      createItem(testDb, week3.id, { text: 'Normal c1', parentItemId: goal.id, priority: 'normal', position: 1 })
      const week5 = createWeekPlan(testDb, '2026-10-26', '2026-11-01')
      createItem(testDb, week5.id, { text: 'High c4', parentItemId: goal.id, priority: 'high', position: 4 })
      createItem(testDb, week5.id, { text: 'High c2', parentItemId: goal.id, priority: 'high', position: 2 })

      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.items.map((item: { text: string }) => item.text)).toEqual([
        'High p1',
        'High p3',
        'Normal p1',
        'Low p1',
      ])
      const goalFromResponse = data.items.find((item: { id: number }) => item.id === goal.id)
      expect(goalFromResponse.childItems.map((child: { text: string }) => child.text)).toEqual([
        'High c2',
        'High c4',
        'Normal c1',
      ])
    })

    it('returns an empty month review when no plan or weeks exist', async () => {
      const request = new Request('http://localhost/api/plans?scope=month&month=2026-10')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.plan).toBeNull()
      expect(data.items).toEqual([])
      expect(data.attachCandidates).toEqual([])
    })

    it('leaves the week-scope response shape unchanged', async () => {
      const weekPlan = createWeekPlan(testDb, '2026-10-12', '2026-10-18')
      createItem(testDb, weekPlan.id, { text: 'Task 1' })

      const request = new Request('http://localhost/api/plans?scope=week&date=2026-10-15')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).not.toHaveProperty('attachCandidates')
      expect(data.items).toHaveLength(1)
      expect(data.items[0]).not.toHaveProperty('childItems')
      expect(data.items[0]).not.toHaveProperty('directFulfillmentCount')
      expect(data.items[0]).not.toHaveProperty('indirectFulfillmentCount')
      expect(data.items[0]).toHaveProperty('fulfillmentCount')
      expect(data.items[0]).toHaveProperty('commentCount')
    })
  })
})
