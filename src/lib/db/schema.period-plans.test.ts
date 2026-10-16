import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { eq, and } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'

function createTestDbWithMigrations() {
  const sqlite = new Database(':memory:')

  // Apply the period plans migration
  const migrationPath = path.join(__dirname, '../../../drizzle/0035_flowery_timeslip.sql')
  const migrationSql = fs.readFileSync(migrationPath, 'utf-8')

  // Split by statement breakpoint and execute each statement
  const statements = migrationSql.split('--> statement-breakpoint')
  for (const stmt of statements) {
    const trimmed = stmt.trim()
    if (trimmed) {
      sqlite.exec(trimmed)
    }
  }

  return drizzle(sqlite, { schema })
}

describe('period_plans schema', () => {
  it('should create period_plans table with correct structure', () => {
    const db = createTestDbWithMigrations()

    // Insert a week plan
    const now = new Date()
    const weekPlan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(weekPlan).toHaveLength(1)
    expect(weekPlan[0].scope).toBe('week')
    expect(weekPlan[0].periodStart).toBe('2026-10-12')
    expect(weekPlan[0].periodEnd).toBe('2026-10-18')
    expect(weekPlan[0].monthKey).toBeNull()

    // Insert a month plan
    const monthPlan = db.insert(schema.periodPlans).values({
      scope: 'month',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      monthKey: '2026-10',
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(monthPlan).toHaveLength(1)
    expect(monthPlan[0].scope).toBe('month')
    expect(monthPlan[0].monthKey).toBe('2026-10')
  })

  it('should enforce unique constraint on (scope, periodStart, periodEnd)', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert first week plan
    db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).run()

    // Try to insert duplicate - should fail
    expect(() => {
      db.insert(schema.periodPlans).values({
        scope: 'week',
        periodStart: '2026-10-12',
        periodEnd: '2026-10-18',
        monthKey: null,
        createdAt: now,
        updatedAt: now,
      }).run()
    }).toThrow()
  })

  it('should enforce unique constraint on (scope, monthKey) for months', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert first month plan
    db.insert(schema.periodPlans).values({
      scope: 'month',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      monthKey: '2026-10',
      createdAt: now,
      updatedAt: now,
    }).run()

    // Try to insert duplicate - should fail
    expect(() => {
      db.insert(schema.periodPlans).values({
        scope: 'month',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        monthKey: '2026-10',
        createdAt: now,
        updatedAt: now,
      }).run()
    }).toThrow()
  })
})

describe('period_plan_items schema', () => {
  it('should create period_plan_items with correct structure', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Create a period plan first
    const plan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Insert an item
    const item = db.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Complete feature X',
      status: 'planned',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: null,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(item).toHaveLength(1)
    expect(item[0].text).toBe('Complete feature X')
    expect(item[0].status).toBe('planned')
    expect(item[0].projectScope).toBe('work')
    expect(item[0].position).toBe(1)
  })

  it('should support parent-child relationships (week item -> month item)', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Create month plan
    const monthPlan = db.insert(schema.periodPlans).values({
      scope: 'month',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      monthKey: '2026-10',
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Create month item
    const monthItem = db.insert(schema.periodPlanItems).values({
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
    const weekPlan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Create week item with parent link to month item
    const weekItem = db.insert(schema.periodPlanItems).values({
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

    expect(weekItem[0].parentItemId).toBe(monthItem[0].id)

    // Query with parent
    const result = db.select().from(schema.periodPlanItems)
      .where(eq(schema.periodPlanItems.parentItemId, monthItem[0].id))
      .all()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(weekItem[0].id)
  })

  it('should support deferral chain (deferredFromItemId)', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Create first week plan
    const week1 = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Create item in first week
    const item1 = db.insert(schema.periodPlanItems).values({
      periodPlanId: week1[0].id,
      text: 'Task to defer',
      status: 'deferred',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: null,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Create next week plan
    const week2 = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-19',
      periodEnd: '2026-10-25',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Create deferred item in second week
    const item2 = db.insert(schema.periodPlanItems).values({
      periodPlanId: week2[0].id,
      text: 'Task to defer',
      status: 'planned',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: item1[0].id,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(item2[0].deferredFromItemId).toBe(item1[0].id)

    // Query deferral chain
    const result = db.select().from(schema.periodPlanItems)
      .where(eq(schema.periodPlanItems.deferredFromItemId, item1[0].id))
      .all()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(item2[0].id)
  })

  it('should support all status values', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    const plan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    const statuses: Array<'planned' | 'in_progress' | 'done' | 'cancelled' | 'deferred'> = [
      'planned', 'in_progress', 'done', 'cancelled', 'deferred'
    ]

    for (let i = 0; i < statuses.length; i++) {
      const item = db.insert(schema.periodPlanItems).values({
        periodPlanId: plan[0].id,
        text: `Task ${statuses[i]}`,
        status: statuses[i],
        projectScope: 'work',
        parentItemId: null,
        deferredFromItemId: null,
        position: i + 1,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      expect(item[0].status).toBe(statuses[i])
    }
  })

  it('should support both projectScope values', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    const plan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Work item
    const workItem = db.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Work task',
      status: 'planned',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: null,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(workItem[0].projectScope).toBe('work')

    // Personal item
    const personalItem = db.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Personal task',
      status: 'planned',
      projectScope: 'personal',
      parentItemId: null,
      deferredFromItemId: null,
      position: 2,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(personalItem[0].projectScope).toBe('personal')
  })

  it('should default projectScope to work', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    const plan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Insert without specifying projectScope
    const item = db.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Task',
      status: 'planned',
      parentItemId: null,
      deferredFromItemId: null,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(item[0].projectScope).toBe('work')
  })

  it('should default status to planned', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    const plan = db.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Insert without specifying status
    const item = db.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Task',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: null,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    expect(item[0].status).toBe('planned')
  })
})
