import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as schema from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { NextRequest } from 'next/server'
import { DELETE } from './route'

/**
 * Deletion consequences at the database level: the route test suite mocks the
 * query builder, so this file exercises the same handler against a real
 * in-memory database to prove which rows survive.
 */
describe('/api/events/[id] DELETE citation cleanup', () => {
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

  const now = new Date('2026-10-12T00:00:00.000Z')

  function seedEvent(content: string) {
    return testDb.insert(schema.rawEvents).values({
      eventTime: new Date('2026-10-12T09:00:00.000Z'),
      source: 'manual',
      content,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]
  }

  function seedPlanItem() {
    const plan = testDb.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]

    return testDb.insert(schema.periodPlanItems).values({
      periodPlanId: plan.id,
      text: 'Ship the feature',
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]
  }

  function seedCitedComment(planItemId: number, eventId: number, content: string) {
    const comment = testDb.insert(schema.planItemComments).values({
      planItemId,
      content,
      author: null,
      createdAt: now,
    }).returning().all()[0]

    testDb.insert(schema.commentReferences).values({
      commentId: comment.id,
      referencedEventId: eventId,
      createdAt: now,
    }).run()

    return comment
  }

  it('removes only the deleted event’s citation rows and keeps the comment text', async () => {
    const target = seedEvent('Target event')
    const other = seedEvent('Other event')
    const item = seedPlanItem()
    const targetComment = seedCitedComment(item.id, target.id, `Cites @${target.id}`)
    const otherComment = seedCitedComment(item.id, other.id, `Cites @${other.id}`)

    const response = await DELETE(
      new NextRequest(`http://localhost/api/events/${target.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: String(target.id) }) },
    )

    expect(response.status).toBe(204)

    const events = testDb.select().from(schema.rawEvents).all()
    expect(events.map((event) => event.id)).not.toContain(target.id)

    // Both comments survive; only the citation index rows change.
    const comments = testDb.select().from(schema.planItemComments).all()
    expect(comments).toHaveLength(2)
    expect(comments.map((comment) => comment.id).sort()).toEqual(
      [targetComment.id, otherComment.id].sort(),
    )
    expect(comments.find((comment) => comment.id === targetComment.id)?.content).toBe(
      `Cites @${target.id}`,
    )

    const citations = testDb.select().from(schema.commentReferences).all()
    expect(citations).toHaveLength(1)
    expect(citations[0].commentId).toBe(otherComment.id)
    expect(citations[0].referencedEventId).toBe(other.id)
  })
})
