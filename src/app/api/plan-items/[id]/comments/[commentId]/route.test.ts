import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as schema from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { DELETE } from './route'

vi.mock('@/lib/auth/password', () => ({ readStartupPassword: () => null }))

describe('/api/plan-items/[id]/comments/[commentId]', () => {
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

  function seedItem(weekOffset = 0) {
    const now = new Date('2026-10-12T00:00:00.000Z')
    const startDay = 12 + weekOffset * 7
    const endDay = 18 + weekOffset * 7
    const plan = testDb.insert(schema.periodPlans).values({
      scope: 'week',
      periodStart: `2026-10-${startDay}`,
      periodEnd: `2026-10-${endDay}`,
      monthKey: null,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    const item = testDb.insert(schema.periodPlanItems).values({
      periodPlanId: plan[0].id,
      text: 'Ship the feature',
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    return item[0]
  }

  function seedComment(planItemId: number, content = 'blocked') {
    return testDb.insert(schema.planItemComments).values({
      planItemId,
      content,
      author: null,
      createdAt: new Date('2026-10-13T09:00:00.000Z'),
    }).returning().all()[0]
  }

  function deleteComment(itemId: number | string, commentId: number | string) {
    return DELETE(
      new Request(`http://localhost/api/plan-items/${itemId}/comments/${commentId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: String(itemId), commentId: String(commentId) }) },
    )
  }

  it('returns 400 for a non-numeric item id', async () => {
    const response = await deleteComment('nope', 1)

    expect(response.status).toBe(400)
  })

  it('returns 400 for a non-numeric comment id', async () => {
    const item = seedItem()

    const response = await deleteComment(item.id, 'nope')

    expect(response.status).toBe(400)
  })

  it('returns 404 when the plan item does not exist', async () => {
    const response = await deleteComment(999, 1)

    expect(response.status).toBe(404)
  })

  it('returns 404 when the comment does not exist', async () => {
    const item = seedItem()

    const response = await deleteComment(item.id, 999)

    expect(response.status).toBe(404)
  })

  it('returns 404 when the comment belongs to another item', async () => {
    const item = seedItem()
    const other = seedItem(1)
    const comment = seedComment(other.id)

    const response = await deleteComment(item.id, comment.id)

    expect(response.status).toBe(404)
    expect(
      testDb.select().from(schema.planItemComments).all().map((row) => row.id),
    ).toContain(comment.id)
  })

  it('deletes the comment and its citation index rows', async () => {
    const item = seedItem()
    const comment = seedComment(item.id)
    const survivor = seedComment(item.id, 'keep me')

    testDb.insert(schema.commentReferences).values({
      commentId: comment.id,
      referencedEventId: 42,
      createdAt: new Date('2026-10-13T09:00:00.000Z'),
    }).run()

    const response = await deleteComment(item.id, comment.id)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.deleted).toBe(true)
    expect(testDb.select().from(schema.commentReferences).all()).toEqual([])
    expect(
      testDb.select().from(schema.planItemComments).all().map((row) => row.id),
    ).toEqual([survivor.id])
  })

  it('does not export read or update handlers', async () => {
    const routeModule = await import('./route')

    expect('GET' in routeModule).toBe(false)
    expect('PUT' in routeModule).toBe(false)
    expect('PATCH' in routeModule).toBe(false)
  })
})
