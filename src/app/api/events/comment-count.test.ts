import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as schema from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { GET } from './route'

describe('/api/events GET comment referrer counts', () => {
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

  function seedEvent(content: string, eventTime: string) {
    return testDb.insert(schema.rawEvents).values({
      eventTime: new Date(eventTime),
      source: 'manual',
      content,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]
  }

  function cite(eventId: number, planItemId: number) {
    const comment = testDb.insert(schema.planItemComments).values({
      planItemId,
      content: `Cites @${eventId}`,
      author: null,
      createdAt: now,
    }).returning().all()[0]

    testDb.insert(schema.commentReferences).values({
      commentId: comment.id,
      referencedEventId: eventId,
      createdAt: now,
    }).run()
  }

  it('adds the number of comments citing each event', async () => {
    const cited = seedEvent('Cited event', '2026-10-12T09:00:00.000Z')
    const plain = seedEvent('Plain event', '2026-10-11T09:00:00.000Z')

    const plan = testDb.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]
    const item = testDb.insert(schema.periodPlanItems).values({
      periodPlanId: plan.id,
      text: 'Ship the feature',
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]

    cite(cited.id, item.id)
    cite(cited.id, item.id)

    const response = await GET(new Request('http://localhost/api/events'))
    const data = await response.json()

    expect(response.status).toBe(200)
    const byId = new Map(
      data.events.map((event: { id: number; commentReferrerCount: number }) => [
        event.id,
        event.commentReferrerCount,
      ]),
    )
    expect(byId.get(cited.id)).toBe(2)
    expect(byId.get(plain.id)).toBe(0)
  })
})
