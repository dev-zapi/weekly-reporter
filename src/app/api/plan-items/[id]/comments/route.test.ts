import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as schema from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { createPat } from '@/lib/auth/pat'
import { GET, POST } from './route'

// The suite runs with WR_AUTH_DISABLED=1 (see src/test/setup.ts); PAT-mode
// cases opt out of that switch themselves.
vi.mock('@/lib/auth/password', () => ({ readStartupPassword: () => null }))

describe('/api/plan-items/[id]/comments', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>
  const originalAuthDisabled = process.env.WR_AUTH_DISABLED

  beforeEach(async () => {
    testDb = createTestDbWithMigrations()
    const dbModule = await import('@/lib/db')
    vi.spyOn(dbModule, 'getDb').mockReturnValue(testDb)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalAuthDisabled === undefined) {
      delete process.env.WR_AUTH_DISABLED
    } else {
      process.env.WR_AUTH_DISABLED = originalAuthDisabled
    }
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

  describe('GET', () => {
    it('returns 400 for a non-numeric item id', async () => {
      const response = await GET(new Request('http://localhost/api/plan-items/nope/comments'), {
        params: Promise.resolve({ id: 'nope' }),
      })

      expect(response.status).toBe(400)
    })

    it('returns 404 when the plan item does not exist', async () => {
      const response = await GET(new Request('http://localhost/api/plan-items/999/comments'), {
        params: Promise.resolve({ id: '999' }),
      })

      expect(response.status).toBe(404)
    })

    it('returns an empty list for an item without comments', async () => {
      const item = seedItem()

      const response = await GET(
        new Request(`http://localhost/api/plan-items/${item.id}/comments`),
        { params: Promise.resolve({ id: String(item.id) }) },
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.comments).toEqual([])
    })

    it('returns comments oldest-first, separating authors', async () => {
      const item = seedItem()
      const newer = new Date('2026-10-14T09:00:00.000Z')
      const older = new Date('2026-10-13T09:00:00.000Z')

      testDb.insert(schema.planItemComments).values([
        { planItemId: item.id, content: 'First', author: null, createdAt: newer },
        { planItemId: item.id, content: 'Second', author: 'period-plans/claude', createdAt: older },
      ]).run()

      const response = await GET(
        new Request(`http://localhost/api/plan-items/${item.id}/comments`),
        { params: Promise.resolve({ id: String(item.id) }) },
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.comments.map((c: { content: string }) => c.content)).toEqual([
        'Second',
        'First',
      ])
      expect(data.comments[0].author).toBe('period-plans/claude')
      expect(data.comments[1].author).toBeNull()
    })

    it('does not return comments belonging to another item', async () => {
      const item = seedItem()
      const other = seedItem(1)
      const now = new Date('2026-10-13T09:00:00.000Z')

      testDb.insert(schema.planItemComments).values([
        { planItemId: item.id, content: 'Mine', author: null, createdAt: now },
        { planItemId: other.id, content: 'Theirs', author: null, createdAt: now },
      ]).run()

      const response = await GET(
        new Request(`http://localhost/api/plan-items/${item.id}/comments`),
        { params: Promise.resolve({ id: String(item.id) }) },
      )
      const data = await response.json()

      expect(data.comments).toHaveLength(1)
      expect(data.comments[0].content).toBe('Mine')
    })
  })

  describe('POST', () => {
    function postJson(itemId: number | string, body: unknown, headers: Record<string, string> = {}) {
      return POST(
        new Request(`http://localhost/api/plan-items/${itemId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(itemId) }) },
      )
    }

    it('returns 400 for a non-numeric item id', async () => {
      const response = await postJson('nope', { content: 'hello' })

      expect(response.status).toBe(400)
    })

    it('returns 404 when the plan item does not exist', async () => {
      const response = await postJson(999, { content: 'hello' })

      expect(response.status).toBe(404)
    })

    it('returns 400 for empty content', async () => {
      const item = seedItem()

      const response = await postJson(item.id, { content: '   ' })

      expect(response.status).toBe(400)
    })

    it('returns 400 when content is missing', async () => {
      const item = seedItem()

      const response = await postJson(item.id, {})

      expect(response.status).toBe(400)
    })

    it('creates a browser comment with author null and trims content', async () => {
      const item = seedItem()

      const response = await postJson(item.id, { content: '  blocked on review  ' })
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.content).toBe('blocked on review')
      expect(data.author).toBeNull()
      expect(data.planItemId).toBe(item.id)

      const listResponse = await GET(
        new Request(`http://localhost/api/plan-items/${item.id}/comments`),
        { params: Promise.resolve({ id: String(item.id) }) },
      )
      const listData = await listResponse.json()
      expect(listData.comments).toHaveLength(1)
      expect(listData.comments[0].content).toBe('blocked on review')
    })

    it('stores the self-reported agent identity for PAT callers', async () => {
      const item = seedItem()
      delete process.env.WR_AUTH_DISABLED
      const { token } = createPat(testDb, 'period-plans-skill')

      const response = await postJson(
        item.id,
        { content: 'defer analysis' },
        {
          Authorization: `Bearer ${token}`,
          'X-Weekly-Reporter-Agent': 'period-plans/claude-code',
        },
      )
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.author).toBe('period-plans/claude-code')
    })

    it('falls back to the PAT name when no agent identity is reported', async () => {
      const item = seedItem()
      delete process.env.WR_AUTH_DISABLED
      const { token } = createPat(testDb, 'period-plans-skill')

      const response = await postJson(
        item.id,
        { content: 'review conclusion' },
        { Authorization: `Bearer ${token}` },
      )
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.author).toBe('period-plans-skill')
    })

    it('parses @id citations once at write and ignores %id/#tag tokens', async () => {
      const item = seedItem()

      const response = await postJson(item.id, {
        content: 'blocked by @17 and @17 again — see %42 #review',
      })

      expect(response.status).toBe(201)

      const rows = testDb.select().from(schema.commentReferences).all()
      expect(rows.map((row) => row.referencedEventId)).toEqual([17])
    })

    it('does not re-parse citations when comments are read back', async () => {
      const item = seedItem()
      await postJson(item.id, { content: 'blocked by @17' })

      await GET(
        new Request(`http://localhost/api/plan-items/${item.id}/comments`),
        { params: Promise.resolve({ id: String(item.id) }) },
      )

      expect(testDb.select().from(schema.commentReferences).all()).toHaveLength(1)
    })

    it('accepts a dangling citation and keeps its index row', async () => {
      const item = seedItem()

      const response = await postJson(item.id, { content: 'was motivated by @999' })

      expect(response.status).toBe(201)
      expect(
        testDb
          .select()
          .from(schema.commentReferences)
          .all()
          .map((row) => row.referencedEventId),
      ).toEqual([999])
    })
  })

  it('does not export an update handler', async () => {
    const routeModule = await import('./route')

    expect('PUT' in routeModule).toBe(false)
    expect('PATCH' in routeModule).toBe(false)
  })
})
