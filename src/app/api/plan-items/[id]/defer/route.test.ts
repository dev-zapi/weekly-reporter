import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { ne, eq } from 'drizzle-orm'
import * as schema from '@/lib/db/schema'
import { POST } from './route'
import fs from 'node:fs'
import path from 'node:path'

function createTestDbWithMigrations() {
  const sqlite = new Database(':memory:')

  // Apply all migrations up to 0035
  const migrationsDir = path.join(__dirname, '../../../../../../drizzle')
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

describe('/api/plan-items/[id]/defer', () => {
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

  describe('POST', () => {
    it('should return 404 when item does not exist', async () => {
      const request = new Request('http://localhost/api/plan-items/999/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: '999' })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toContain('not found')
    })

    it('should defer week item to next week', async () => {
      const now = new Date()

      // Create first week plan
      const week1 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create item in first week
      const item1 = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week1[0].id,
        text: 'Task to defer',
        status: 'in_progress',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item1[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(item1[0].id) })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.text).toBe('Task to defer')
      expect(data.projectScope).toBe('work')
      expect(data.deferredFromItemId).toBe(item1[0].id)
      expect(data.status).toBe('planned')

      // Verify the new item is in the next week
      const week2 = testDb.select().from(schema.periodPlans)
        .where(ne(schema.periodPlans.id, week1[0].id))
        .all()
      expect(week2).toHaveLength(1)
      expect(week2[0].periodStart).toBe('2026-10-19')
      expect(week2[0].periodEnd).toBe('2026-10-25')
      expect(data.periodPlanId).toBe(week2[0].id)

      // Verify original item is now marked as deferred
      const updatedOriginal = testDb.select().from(schema.periodPlanItems)
        .where(eq(schema.periodPlanItems.id, item1[0].id))
        .all()
      expect(updatedOriginal[0].status).toBe('deferred')
    })

    it('should defer month item to next month', async () => {
      const now = new Date()

      // Create first month plan
      const month1 = testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create item in first month
      const item1 = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: month1[0].id,
        text: 'Monthly task to defer',
        status: 'in_progress',
        projectScope: 'personal',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item1[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(item1[0].id) })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.text).toBe('Monthly task to defer')
      expect(data.projectScope).toBe('personal')
      expect(data.deferredFromItemId).toBe(item1[0].id)

      // Verify the new item is in the next month
      const month2 = testDb.select().from(schema.periodPlans)
        .where(ne(schema.periodPlans.id, month1[0].id))
        .all()
      expect(month2).toHaveLength(1)
      expect(month2[0].monthKey).toBe('2026-11')
      expect(data.periodPlanId).toBe(month2[0].id)

      // Verify original item is now marked as deferred
      const updatedOriginal = testDb.select().from(schema.periodPlanItems)
        .where(eq(schema.periodPlanItems.id, item1[0].id))
        .all()
      expect(updatedOriginal[0].status).toBe('deferred')
    })

    it('should inherit parentItemId from original item', async () => {
      const now = new Date()

      // Create month plan and item
      const monthPlan = testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const monthItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: monthPlan[0].id,
        text: 'Monthly goal',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create first week plan
      const week1 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create week item with parent link
      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week1[0].id,
        text: 'Weekly task',
        status: 'in_progress',
        projectScope: 'work',
        parentItemId: monthItem[0].id,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.parentItemId).toBe(monthItem[0].id)
    })

    it('should drop an inherited parent link that no longer covers the new week', async () => {
      const now = new Date()

      // Parent month is October; the deferred week start falls in November.
      const monthPlan = testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const monthItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: monthPlan[0].id,
        text: 'October goal',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Week starting Mon 2026-10-26 (still in October).
      const week1 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-26',
        periodEnd: '2026-11-01',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week1[0].id,
        text: 'Weekly task',
        status: 'in_progress',
        projectScope: 'work',
        parentItemId: monthItem[0].id,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.deferredFromItemId).toBe(weekItem[0].id)
      expect(data.parentItemId).toBeNull()
    })

    it('should append to end of target period', async () => {
      const now = new Date()

      // Create first week plan
      const week1 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create item to defer
      const item1 = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week1[0].id,
        text: 'Task to defer',
        status: 'in_progress',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create next week plan with existing items
      const week2 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-19',
        periodEnd: '2026-10-25',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week2[0].id,
        text: 'Existing task 1',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week2[0].id,
        text: 'Existing task 2',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 2,
        createdAt: now,
        updatedAt: now,
      }).run()

      const request = new Request('http://localhost/api/plan-items/' + item1[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(item1[0].id) })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.position).toBe(3) // Should be appended at position 3
      expect(data.periodPlanId).toBe(week2[0].id)
    })

    it('should allow deferring an already-deferred item', async () => {
      const now = new Date()

      // Create first week plan
      const week1 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create already-deferred item
      const item1 = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week1[0].id,
        text: 'Already deferred task',
        status: 'deferred',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: 999, // Previously deferred from somewhere
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item1[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(item1[0].id) })
      const response = await POST(request, { params })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.text).toBe('Already deferred task')
      expect(data.deferredFromItemId).toBe(item1[0].id)
      expect(data.status).toBe('planned')
    })

    it('should create next period if it does not exist', async () => {
      const now = new Date()

      // Create first week plan
      const week1 = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create item to defer
      const item1 = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: week1[0].id,
        text: 'Task to defer',
        status: 'in_progress',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Verify only one plan exists
      const plansBefore = testDb.select().from(schema.periodPlans).all()
      expect(plansBefore).toHaveLength(1)

      const request = new Request('http://localhost/api/plan-items/' + item1[0].id + '/defer', {
        method: 'POST',
      })
      const params = Promise.resolve({ id: String(item1[0].id) })
      const response = await POST(request, { params })

      expect(response.status).toBe(201)

      // Verify two plans now exist
      const plansAfter = testDb.select().from(schema.periodPlans).all()
      expect(plansAfter).toHaveLength(2)
    })
  })
})
