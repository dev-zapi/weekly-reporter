import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/lib/db/schema'
import { POST } from './route'
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

describe('/api/plan-items', () => {
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

  describe('POST', () => {
    it('should return 400 when periodPlanId is missing and scope/period params missing', async () => {
      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test item' }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('periodplanid')
    })

    it('should return 400 when text is empty', async () => {
      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: 1,
          text: ''
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('text')
    })

    it('should return 400 when text is whitespace only', async () => {
      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: 1,
          text: '   '
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error.toLowerCase()).toContain('text')
    })

    it('should create item with existing periodPlanId', async () => {
      const now = new Date()

      // Create a plan first
      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: plan[0].id,
          text: 'Complete feature X',
          projectScope: 'work'
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.text).toBe('Complete feature X')
      expect(data.status).toBe('planned')
      expect(data.projectScope).toBe('work')
      expect(data.periodPlanId).toBe(plan[0].id)
      expect(data.position).toBe(1)
    })

    it('should default projectScope to work when not provided', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: plan[0].id,
          text: 'Task'
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.projectScope).toBe('work')
    })

    it('should auto-increment position for items in same plan', async () => {
      const now = new Date()

      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      // Create first item
      const request1 = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: plan[0].id,
          text: 'Task 1'
        }),
      })
      const response1 = await POST(request1)
      const data1 = await response1.json()

      expect(data1.position).toBe(1)

      // Create second item
      const request2 = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: plan[0].id,
          text: 'Task 2'
        }),
      })
      const response2 = await POST(request2)
      const data2 = await response2.json()

      expect(data2.position).toBe(2)
    })

    it('should ensure period plan exists when scope and period params provided', async () => {
      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'week',
          weekStart: '2026-10-12',
          weekEnd: '2026-10-18',
          text: 'Task'
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.text).toBe('Task')
      expect(data.periodPlanId).toBeDefined()

      // Verify plan was created
      const plans = testDb.select().from(schema.periodPlans).all()
      expect(plans).toHaveLength(1)
      expect(plans[0].scope).toBe('week')
      expect(plans[0].periodStart).toBe('2026-10-12')
      expect(plans[0].periodEnd).toBe('2026-10-18')
    })

    it('should ensure month plan exists when scope=month and month param provided', async () => {
      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'month',
          month: '2026-10',
          text: 'Monthly task'
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.periodPlanId).toBeDefined()

      // Verify plan was created
      const plans = testDb.select().from(schema.periodPlans).all()
      expect(plans).toHaveLength(1)
      expect(plans[0].scope).toBe('month')
      expect(plans[0].monthKey).toBe('2026-10')
    })

    it('should reuse existing plan when ensuring', async () => {
      const now = new Date()

      // Create a plan first
      const plan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'week',
          weekStart: '2026-10-12',
          weekEnd: '2026-10-18',
          text: 'Task'
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.periodPlanId).toBe(plan[0].id)

      // Verify no duplicate plan was created
      const plans = testDb.select().from(schema.periodPlans).all()
      expect(plans).toHaveLength(1)
    })

    it('should accept parentItemId for week-to-month link', async () => {
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

      // Create week plan
      const weekPlan = testDb.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      const request = new Request('http://localhost/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodPlanId: weekPlan[0].id,
          text: 'Weekly task',
          parentItemId: monthItem[0].id
        }),
      })
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.parentItemId).toBe(monthItem[0].id)
    })
  })
})
