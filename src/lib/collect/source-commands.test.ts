import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  syncSource,
  fetchRepo,
  toggleSource,
  deleteSource,
  bulkUpdateScope,
  bulkDelete,
} from './source-commands'
import { AUTH_STORAGE_KEY } from '../api-client'

function mockFetch(response: unknown, init?: { ok?: boolean }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: init?.ok ?? true,
    json: () => Promise.resolve(response),
  }) as unknown as typeof fetch
}

function lastFetchCall() {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1]
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  localStorage.clear()
})

describe('syncSource', () => {
  it('POSTs sourceId without resync by default', async () => {
    mockFetch({ result: { status: 'success', eventsCount: 3 } })
    const result = await syncSource(7)
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/collect/git-remote/sync')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ sourceId: 7 })
    expect(result).toEqual({ ok: true, eventsCount: 3, warnings: undefined })
  })

  it('POSTs sourceId with resync:true when requested', async () => {
    mockFetch({ result: { status: 'success', eventsCount: 12, warnings: ['x'] } })
    const result = await syncSource(7, { resync: true })
    const [, init] = lastFetchCall()
    expect(JSON.parse(init.body)).toEqual({ sourceId: 7, resync: true })
    expect(result).toEqual({ ok: true, eventsCount: 12, warnings: ['x'] })
  })

  it('returns autoDisabled when result.autoDisabled is set', async () => {
    mockFetch({ result: { autoDisabled: true } })
    const result = await syncSource(7)
    expect(result).toEqual({ ok: false, autoDisabled: true })
  })

  it('returns error string on generic failure', async () => {
    mockFetch({ error: 'boom' })
    const result = await syncSource(7)
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})

describe('fetchRepo', () => {
  it('POSTs to git-local/fetch', async () => {
    mockFetch({ result: { status: 'success' } })
    const result = await fetchRepo(4)
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/collect/git-local/fetch')
    expect(JSON.parse(init.body)).toEqual({ sourceId: 4 })
    expect(result).toEqual({ ok: true })
  })

  it('returns error on failure', async () => {
    mockFetch({ error: 'fetch failed' }, { ok: false })
    const result = await fetchRepo(4)
    expect(result).toEqual({ ok: false, error: 'fetch failed' })
  })

  it('attaches the stored password as a Bearer token (regression: raw fetch got 401)', async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, 'sekrit')
    mockFetch({ result: { status: 'success' } })
    await fetchRepo(4)
    const [, init] = lastFetchCall()
    expect(init.headers.Authorization).toBe('Bearer sekrit')
  })
})

describe('toggleSource', () => {
  it('PATCHes the status', async () => {
    mockFetch({})
    const result = await toggleSource(7, 'enabled')
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/collect/sources/7')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ status: 'enabled' })
    expect(result).toEqual({ ok: true })
  })

  it('returns error when PATCH fails', async () => {
    mockFetch({ error: 'nope' }, { ok: false })
    const result = await toggleSource(7, 'disabled')
    expect(result).toEqual({ ok: false, error: 'nope' })
  })
})

describe('deleteSource', () => {
  it('DELETEs the source', async () => {
    mockFetch({ success: true })
    const result = await deleteSource(7)
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/collect/sources/7')
    expect(init.method).toBe('DELETE')
    expect(result).toEqual({ ok: true })
  })
})

describe('bulkUpdateScope', () => {
  it('POSTs ids and projectScope', async () => {
    mockFetch({ success: true, updatedCount: 2 })
    const result = await bulkUpdateScope([1, 2], 'work')
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/collect/sources/bulk-update-scope')
    expect(JSON.parse(init.body)).toEqual({ ids: [1, 2], projectScope: 'work' })
    expect(result).toEqual({ ok: true, updatedCount: 2 })
  })
})

describe('bulkDelete', () => {
  it('POSTs ids to bulk-delete', async () => {
    mockFetch({ success: true, deletedCount: 2 })
    const result = await bulkDelete([1, 2])
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/collect/sources/bulk-delete')
    expect(JSON.parse(init.body)).toEqual({ ids: [1, 2] })
    expect(result).toEqual({ ok: true, deletedCount: 2 })
  })
})
