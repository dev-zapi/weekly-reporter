import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as schema from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { NextRequest } from 'next/server'
import { GET } from './route'

describe('/api/events/[id]/references', () => {
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

  function seedEvent(params: { content?: string; source?: string } = {}) {
    return testDb.insert(schema.rawEvents).values({
      eventTime: new Date('2026-10-12T09:00:00.000Z'),
      source: params.source ?? 'manual',
      content: params.content ?? 'Target event',
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0]
  }

  function seedPlanItem(params: {
    scope?: 'week' | 'month'
    periodStart?: string
    periodEnd?: string
    monthKey?: string | null
  } = {}) {
    const plan = testDb.insert(schema.periodPlans).values({
      scope: params.scope ?? 'week',
      periodStart: params.periodStart ?? '2026-10-12',
      periodEnd: params.periodEnd ?? '2026-10-18',
      monthKey: params.monthKey ?? null,
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

  function seedCitation(params: {
    planItemId: number
    referencedEventId: number
    content: string
    author?: string | null
  }) {
    const comment = testDb.insert(schema.planItemComments).values({
      planItemId: params.planItemId,
      content: params.content,
      author: params.author ?? null,
      createdAt: now,
    }).returning().all()[0]

    testDb.insert(schema.commentReferences).values({
      commentId: comment.id,
      referencedEventId: params.referencedEventId,
      createdAt: now,
    }).run()

    return comment
  }

  it('returns an empty comment referrer list when no comment cites the event', async () => {
    const event = seedEvent()

    const response = await GET(
      new NextRequest(`http://localhost/api/events/${event.id}/references`),
      { params: Promise.resolve({ id: String(event.id) }) },
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.referrers).toEqual([])
    expect(data.commentReferrers).toEqual({ count: 0, comments: [] })
  })

  it('returns comment referrers with count, excerpt, owning item and source period', async () => {
    const event = seedEvent()
    const item = seedPlanItem({
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
    })
    seedCitation({
      planItemId: item.id,
      referencedEventId: event.id,
      content: 'Decision motivated by @' + event.id,
      author: 'period-plans/claude',
    })

    const response = await GET(
      new NextRequest(`http://localhost/api/events/${event.id}/references`),
      { params: Promise.resolve({ id: String(event.id) }) },
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.commentReferrers.count).toBe(1)
    expect(data.commentReferrers.comments).toHaveLength(1)
    expect(data.commentReferrers.comments[0]).toMatchObject({
      planItemId: item.id,
      author: 'period-plans/claude',
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
    })
    expect(data.commentReferrers.comments[0].commentId).toBeGreaterThan(0)
    expect(data.commentReferrers.comments[0].excerpt).toContain(`@${event.id}`)
  })

  it('truncates long comment excerpts', async () => {
    const event = seedEvent()
    const item = seedPlanItem()
    seedCitation({
      planItemId: item.id,
      referencedEventId: event.id,
      content: `${'x'.repeat(200)} @${event.id}`,
    })

    const response = await GET(
      new NextRequest(`http://localhost/api/events/${event.id}/references`),
      { params: Promise.resolve({ id: String(event.id) }) },
    )
    const data = await response.json()

    expect(data.commentReferrers.comments[0].excerpt.length).toBeLessThanOrEqual(81)
    expect(data.commentReferrers.comments[0].excerpt.endsWith('…')).toBe(true)
  })

  it('keeps event referrers alongside comment referrers', async () => {
    const target = seedEvent({ content: 'Target event' })
    const referrer = seedEvent({ content: `Mentions @${target.id}` })
    testDb.insert(schema.eventReferences).values({
      eventId: referrer.id,
      referencedEventId: target.id,
      createdAt: now,
    }).run()

    const item = seedPlanItem()
    seedCitation({ planItemId: item.id, referencedEventId: target.id, content: `Note @${target.id}` })

    const response = await GET(
      new NextRequest(`http://localhost/api/events/${target.id}/references`),
      { params: Promise.resolve({ id: String(target.id) }) },
    )
    const data = await response.json()

    expect(data.referrers.map((r: { id: number }) => r.id)).toEqual([referrer.id])
    expect(data.commentReferrers.count).toBe(1)
  })

  it('returns 404 when the event does not exist', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/events/999/references'),
      { params: Promise.resolve({ id: '999' }) },
    )

    expect(response.status).toBe(404)
  })
})
