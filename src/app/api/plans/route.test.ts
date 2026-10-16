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
  })
})
