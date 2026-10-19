import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as schema from '@/lib/db/schema'
import { findPlanReferrers } from './referrers'
import { createTestDbWithMigrations } from '@/test/db'

describe('findPlanReferrers', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(async () => {
    testDb = createTestDbWithMigrations()
  })

  afterEach(() => {
    const client = (testDb as unknown as { $client?: { close?: () => void } }).$client
    client?.close?.()
  })

  it('should return empty array when no events reference the plan item', () => {
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

    const referrers = findPlanReferrers(testDb, item[0].id)
    expect(referrers).toHaveLength(0)
  })

  it('should return events that reference the plan item', () => {
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

    const referrers = findPlanReferrers(testDb, item[0].id)
    expect(referrers).toHaveLength(1)
    expect(referrers[0].id).toBe(event[0].id)
    expect(referrers[0].content).toBe('Worked on %' + item[0].id)
    expect(referrers[0].eventTime).toBeInstanceOf(Date)
  })

  it('should return multiple events referencing the same plan item', () => {
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

    const referrers = findPlanReferrers(testDb, item[0].id)
    expect(referrers).toHaveLength(2)
    expect(referrers.map(r => r.id)).toEqual(expect.arrayContaining([event1[0].id, event2[0].id]))
  })

  it('should only return events for the specific plan item', () => {
    const now = new Date()

    const plan = testDb.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    const item1 = testDb.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Item 1',
      status: 'planned',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: null,
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    const item2 = testDb.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Item 2',
      status: 'planned',
      projectScope: 'work',
      parentItemId: null,
      deferredFromItemId: null,
      position: 2,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    const event1 = testDb.insert(schema.rawEvents).values({
      content: 'Event for item 1 %' + item1[0].id,
      eventTime: now,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    const event2 = testDb.insert(schema.rawEvents).values({
      content: 'Event for item 2 %' + item2[0].id,
      eventTime: now,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    testDb.insert(schema.eventPlanReferences).values([
      { eventId: event1[0].id, planItemId: item1[0].id, createdAt: now },
      { eventId: event2[0].id, planItemId: item2[0].id, createdAt: now },
    ]).run()

    const referrers = findPlanReferrers(testDb, item1[0].id)
    expect(referrers).toHaveLength(1)
    expect(referrers[0].id).toBe(event1[0].id)
    expect(referrers[0].content).toContain('%' + item1[0].id)
  })
})
