import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/lib/db/schema'
import { GET, PUT, DELETE } from './route'
import fs from 'node:fs'
import path from 'node:path'

function createTestDbWithMigrations() {
  const sqlite = new Database(':memory:')

  // Apply all migrations up to 0035
  const migrationsDir = path.join(__dirname, '../../../../../drizzle')
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

describe('/api/plan-items/[id]', () => {
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
      const request = new Request('http://localhost/api/plan-items/999')
      const params = Promise.resolve({ id: '999' })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toContain('not found')
    })

    it('should return item when it exists', async () => {
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

      const request = new Request('http://localhost/api/plan-items/' + item[0].id)
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.id).toBe(item[0].id)
      expect(data.text).toBe('Test item')
    })

    it('should return period identity and deferral chain', async () => {
      const now = new Date()

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

      const request = new Request('http://localhost/api/plan-items/30')
      const params = Promise.resolve({ id: '30' })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.id).toBe(30)
      expect(data.period).toEqual({
        id: 3,
        scope: 'week',
        periodStart: '2026-10-19',
        periodEnd: '2026-10-25',
      })
      expect(data.deferralChain).toEqual([30, 20, 10])
    })

    it('should include referring events so deletion can warn before it happens', async () => {
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
        text: 'Referenced item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const event = testDb.insert(schema.rawEvents).values({
        content: 'Did work on %' + item[0].id,
        eventTime: now,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.eventPlanReferences).values({
        eventId: event[0].id,
        planItemId: item[0].id,
        createdAt: now,
      }).run()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id)
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.referrers).toHaveLength(1)
      expect(data.referrers[0].id).toBe(event[0].id)
      expect(data.referrers[0].content).toBe('Did work on %' + item[0].id)
    })

    it('should return an empty referrers list when no events reference the item', async () => {
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
        text: 'Unreferenced item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id)
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await GET(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.referrers).toEqual([])
    })
  })

  describe('PUT', () => {
    it('should return 404 when item does not exist', async () => {
      const request = new Request('http://localhost/api/plan-items/999', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated' }),
      })
      const params = Promise.resolve({ id: '999' })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toContain('not found')
    })

    it('should return 400 when text is empty', async () => {
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
        text: 'Original',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('text')
    })

    it('should update text', async () => {
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
        text: 'Original',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated text' }),
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.text).toBe('Updated text')
    })

    it('should update status', async () => {
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
        text: 'Task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.status).toBe('done')
    })

    it('should update projectScope', async () => {
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
        text: 'Task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectScope: 'personal' }),
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.projectScope).toBe('personal')
    })

    it('should update position', async () => {
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
        text: 'Task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: 5 }),
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.position).toBe(5)
    })

    it('should update parentItemId', async () => {
      const now = new Date()

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

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Weekly task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentItemId: monthItem[0].id }),
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.parentItemId).toBe(monthItem[0].id)
    })

    it('should reject a parentItemId that does not exist', async () => {
      const now = new Date()

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Weekly task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentItemId: 9999 }),
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('parentitemid')
    })

    it('should reject a parent that is not a month item', async () => {
      const now = new Date()

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekParent = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Week parent',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Weekly task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 2,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentItemId: weekParent[0].id }),
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('month')
    })

    it('should reject a parent whose month does not contain the week start', async () => {
      const now = new Date()

      const monthPlan = testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        monthKey: '2026-09',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const monthItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: monthPlan[0].id,
        text: 'September goal',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Weekly task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentItemId: monthItem[0].id }),
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('parentitemid')
    })

    it('should allow clearing the parent link with null', async () => {
      const now = new Date()

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

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const weekItem = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Weekly task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: monthItem[0].id,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + weekItem[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentItemId: null }),
      })
      const params = Promise.resolve({ id: String(weekItem[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.parentItemId).toBeNull()
    })

    it('should update multiple fields at once', async () => {
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
        text: 'Original',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Updated',
          status: 'in_progress',
          projectScope: 'personal'
        }),
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await PUT(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.text).toBe('Updated')
      expect(data.status).toBe('in_progress')
      expect(data.projectScope).toBe('personal')
    })
  })

  describe('DELETE', () => {
    it('should return 404 when item does not exist', async () => {
      const request = new Request('http://localhost/api/plan-items/999', {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: '999' })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toContain('not found')
    })

    it('should delete item when it exists', async () => {
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
        text: 'To delete',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.deleted).toBe(true)

      // Verify item is deleted
      const items = testDb.select().from(schema.periodPlanItems).all()
      expect(items).toHaveLength(0)
    })

    it('should clear the parent link on children when deleting a parent', async () => {
      const now = new Date()

      const monthPlan = testDb.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const parent = testDb.insert(schema.periodPlanItems).values({
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

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const child = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Weekly task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: parent[0].id,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + parent[0].id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(parent[0].id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.deleted).toBe(true)

      // The child survives, but its dangling parent link is cleared.
      const remaining = testDb.select().from(schema.periodPlanItems).all()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(child[0].id)
      expect(remaining[0].parentItemId).toBeNull()
    })

    it('should preserve deferredFromItemId chains when deleting the referenced item', async () => {
      const now = new Date()

      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const original = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Original task',
        status: 'deferred',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const carried = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: weekPlan[0].id,
        text: 'Carried task',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: original[0].id,
        position: 2,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + original[0].id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(original[0].id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.deleted).toBe(true)

      // The historical deferral chain is kept as a dangling reference.
      const remaining = testDb.select().from(schema.periodPlanItems).all()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(carried[0].id)
      expect(remaining[0].deferredFromItemId).toBe(original[0].id)
    })

    it('should clear inbound reference rows when the item is referenced', async () => {
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
        text: 'Referenced item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const event = testDb.insert(schema.rawEvents).values({
        content: 'Worked on %' + item[0].id,
        eventTime: now,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.eventPlanReferences).values({
        eventId: event[0].id,
        planItemId: item[0].id,
        createdAt: now,
      }).run()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({ deleted: true })

      // The item is gone and its inbound association rows are cleared so
      // fulfillment reads never point at a dead item. The `%id` text stays in
      // the event content (a dangling reference, per ADR-0019).
      expect(testDb.select().from(schema.periodPlanItems).all()).toHaveLength(0)
      expect(testDb.select().from(schema.eventPlanReferences).all()).toHaveLength(0)
      const remainingEvents = testDb.select().from(schema.rawEvents).all()
      expect(remainingEvents).toHaveLength(1)
      expect(remainingEvents[0].content).toBe('Worked on %' + item[0].id)
    })

    it('should return only { deleted: true } when no events reference the item', async () => {
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
        text: 'Unreferenced item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({ deleted: true })

      // Verify item is actually deleted
      const items = testDb.select().from(schema.periodPlanItems).all()
      expect(items).toHaveLength(0)
    })

    it('should clear all inbound reference rows for multiple referencing events', async () => {
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
        text: 'Referenced item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const event1 = testDb.insert(schema.rawEvents).values({
        content: 'First event %' + item[0].id,
        eventTime: now,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const event2 = testDb.insert(schema.rawEvents).values({
        content: 'Second event %' + item[0].id,
        eventTime: new Date(now.getTime() + 1000),
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.eventPlanReferences).values([
        { eventId: event1[0].id, planItemId: item[0].id, createdAt: now },
        { eventId: event2[0].id, planItemId: item[0].id, createdAt: now },
      ]).run()

      const request = new Request('http://localhost/api/plan-items/' + item[0].id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(item[0].id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({ deleted: true })
      expect(testDb.select().from(schema.eventPlanReferences).all()).toHaveLength(0)
      expect(testDb.select().from(schema.periodPlanItems).all()).toHaveLength(0)
    })

    it('should leave other items reference rows intact', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const [item1] = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Deleted item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const [item2] = testDb.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: 'Surviving item',
        status: 'planned',
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: 2,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const [event] = testDb.insert(schema.rawEvents).values({
        content: 'Worked on %' + item1.id + ' and %' + item2.id,
        eventTime: now,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      testDb.insert(schema.eventPlanReferences).values([
        { eventId: event.id, planItemId: item1.id, createdAt: now },
        { eventId: event.id, planItemId: item2.id, createdAt: now },
      ]).run()

      const request = new Request('http://localhost/api/plan-items/' + item1.id, {
        method: 'DELETE',
      })
      const params = Promise.resolve({ id: String(item1.id) })
      const response = await DELETE(request, { params })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({ deleted: true })

      // Only the surviving item's association row remains.
      const refs = testDb.select().from(schema.eventPlanReferences).all()
      expect(refs).toHaveLength(1)
      expect(refs[0].planItemId).toBe(item2.id)
    })
  })
})
