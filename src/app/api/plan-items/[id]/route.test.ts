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

      expect(response.status).toBe(204)

      // Verify item is deleted
      const items = testDb.select().from(schema.periodPlanItems).all()
      expect(items).toHaveLength(0)
    })
  })
})
