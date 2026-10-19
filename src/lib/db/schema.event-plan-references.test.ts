import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { eq, and } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'

function createTestDbWithMigrations() {
  const sqlite = new Database(':memory:')

  // Apply all migrations up to the new event_plan_references migration
  const drizzleDir = path.join(__dirname, '../../../drizzle')

  // Read and apply migrations in order
  const migrationFiles = fs.readdirSync(drizzleDir)
    .filter(f => f.match(/^\d+_.*\.sql$/))
    .sort()

  for (const file of migrationFiles) {
    const migrationPath = path.join(drizzleDir, file)
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8')

    // Split by statement breakpoint and execute each statement
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

describe('event_plan_references schema', () => {
  it('should create event_plan_references table with correct structure', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert a reference
    const ref = db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 42,
      createdAt: now,
    }).returning().all()

    expect(ref).toHaveLength(1)
    expect(ref[0].eventId).toBe(1)
    expect(ref[0].planItemId).toBe(42)
    // SQLite stores timestamps with second precision
    expect(ref[0].createdAt.getTime()).toBe(Math.floor(now.getTime() / 1000) * 1000)
  })

  it('should enforce unique constraint on (eventId, planItemId)', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert first reference
    db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 42,
      createdAt: now,
    }).run()

    // Try to insert duplicate - should fail
    expect(() => {
      db.insert(schema.eventPlanReferences).values({
        eventId: 1,
        planItemId: 42,
        createdAt: now,
      }).run()
    }).toThrow()
  })

  it('should allow same event referencing different plan items', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert first reference
    db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 42,
      createdAt: now,
    }).run()

    // Insert second reference with same event but different plan item
    const ref2 = db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 43,
      createdAt: now,
    }).returning().all()

    expect(ref2).toHaveLength(1)
    expect(ref2[0].planItemId).toBe(43)
  })

  it('should allow same plan item referenced by different events', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert first reference
    db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 42,
      createdAt: now,
    }).run()

    // Insert second reference with different event but same plan item
    const ref2 = db.insert(schema.eventPlanReferences).values({
      eventId: 2,
      planItemId: 42,
      createdAt: now,
    }).returning().all()

    expect(ref2).toHaveLength(1)
    expect(ref2[0].eventId).toBe(2)
  })

  it('should support querying by planItemId (index verification)', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert multiple references
    db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 42,
      createdAt: now,
    }).run()

    db.insert(schema.eventPlanReferences).values({
      eventId: 2,
      planItemId: 42,
      createdAt: now,
    }).run()

    db.insert(schema.eventPlanReferences).values({
      eventId: 3,
      planItemId: 43,
      createdAt: now,
    }).run()

    // Query by planItemId
    const refs = db.select().from(schema.eventPlanReferences)
      .where(eq(schema.eventPlanReferences.planItemId, 42))
      .all()

    expect(refs).toHaveLength(2)
    expect(refs.map(r => r.eventId).sort()).toEqual([1, 2])
  })

  it('should support querying by eventId', () => {
    const db = createTestDbWithMigrations()
    const now = new Date()

    // Insert multiple references for same event
    db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 42,
      createdAt: now,
    }).run()

    db.insert(schema.eventPlanReferences).values({
      eventId: 1,
      planItemId: 43,
      createdAt: now,
    }).run()

    // Query by eventId
    const refs = db.select().from(schema.eventPlanReferences)
      .where(eq(schema.eventPlanReferences.eventId, 1))
      .all()

    expect(refs).toHaveLength(2)
    expect(refs.map(r => r.planItemId).sort()).toEqual([42, 43])
  })
})
