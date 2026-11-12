// Behaviour tests for the onboarding & sync half of `wrp sources` (ticket #128):
// `lookup`, `emails` and `sync`.
//
// One seam only: the real CLI as a subprocess against a stub HTTP server. The
// tests assert the requests the client sends, the lines it prints and its exit
// codes. `lookup`'s exit code 3 is the clean "not onboarded" branch signal, so it
// is asserted exactly.

import { describe, it, expect, afterEach } from 'vitest'
import { runWrp, startStubServer } from './wrp-cli-harness.mjs'

/** Decode the one JSON error envelope a failing run printed on stderr. */
function errorEnvelope(result) {
  const lines = result.stderr.trimEnd().split('\n')
  return JSON.parse(lines.at(-1))
}

const stubs = []

async function stub(respond) {
  const server = await startStubServer(respond)
  stubs.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

function source(overrides = {}) {
  return {
    id: 7,
    type: 'git-local',
    name: 'acme',
    config: {
      owner: '/repos/acme',
      authorEmails: ['a@example.com', 'b@example.com'],
      aliases: ['acme-local'],
      branches: [{ name: 'main', lastCommitTime: '2026-10-01T10:00:00.000Z' }],
      branchCursors: [{ name: 'main', lastCommitTime: '2026-10-01T10:00:00.000Z' }],
    },
    enabled: true,
    status: 'enabled',
    projectScope: 'work',
    lastSyncAt: '2026-11-07T10:00:00.000Z',
    lastSyncStatus: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function query(url) {
  return Object.fromEntries(new URL(url, 'http://x').searchParams)
}

describe('wrp sources lookup', () => {
  it('prints the source record verbatim for a registered path and exits 0', async () => {
    const body = source()
    const server = await stub(() => ({ status: 200, body }))

    const result = await runWrp(['sources', 'lookup', '--path', '/repos/acme'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(query(server.requests[0].url)).toEqual({ type: 'git-local', path: '/repos/acme' })
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual(body)
  })

  it('leaves an empty branch config verbatim, keeping the all-branches sentinel visible', async () => {
    const body = source({ config: { owner: '/repos/acme', authorEmails: ['a@example.com'] } })
    const server = await stub(() => ({ status: 200, body }))

    const result = await runWrp(['sources', 'lookup', '--path', '/repos/acme'], { stub: server })

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(body)
    expect(JSON.parse(result.stdout).config).not.toHaveProperty('branches')
  })

  it('exits 3 with the not-found envelope when no source is registered for the path', async () => {
    const server = await stub(() => ({
      status: 404,
      body: { error: '采集源不存在', code: 'NOT_FOUND' },
    }))

    const result = await runWrp(['sources', 'lookup', '--path', '/repos/ghost'], { stub: server })

    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(404)
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toContain("no collect source for path '/repos/ghost'")
    expect(error.fix).toContain('exit 3')
  })

  it('keeps every other lookup failure at a non-3 exit code', async () => {
    const server = await stub(() => ({ status: 500, body: { error: '查询采集源失败', code: 'LOOKUP_ERROR' } }))

    const result = await runWrp(['sources', 'lookup', '--path', '/repos/acme'], { stub: server })

    expect(result.code).not.toBe(3)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(500)
    expect(error.code).toBe('LOOKUP_ERROR')
    expect(error.message).toBe('查询采集源失败')
  })

  it('requires --path before any request', async () => {
    const server = await stub()
    const result = await runWrp(['sources', 'lookup'], { stub: server })

    expect(result.code).not.toBe(3)
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('missing repository path (--path)')
    expect(server.requests).toHaveLength(0)
  })
})

describe('wrp sources emails', () => {
  it('prints the authors body verbatim in server order', async () => {
    const body = {
      authors: [
        { email: 'a@example.com', name: 'Alice', count: 12 },
        { email: 'b@example.com', name: 'Bob', count: 3 },
      ],
    }
    const server = await stub(() => ({ status: 200, body }))

    const result = await runWrp(['sources', 'emails', '--path', '/repos/acme'], { stub: server })

    expect(result.code).toBe(0)
    expect(query(server.requests[0].url)).toEqual({ type: 'git-local', path: '/repos/acme' })
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual(body)
  })

  it('prints the raw empty body when the repo has no commit authors', async () => {
    const server = await stub(() => ({ status: 200, body: { authors: [] } }))

    const result = await runWrp(['sources', 'emails', '--path', '/repos/acme'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('(no commit authors found in the last 300 commits)')
    expect(JSON.parse(result.stdout)).toEqual({ authors: [] })
  })

  it('passes a server failure through as one envelope', async () => {
    const server = await stub(() => ({ status: 500, body: { error: '读取仓库失败', code: 'EMAILS_ERROR' } }))

    const result = await runWrp(['sources', 'emails', '--path', '/repos/acme'], { stub: server })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(500)
    expect(error.code).toBe('EMAILS_ERROR')
    expect(error.message).toBe('读取仓库失败')
  })
})

describe('wrp sources sync', () => {
  function syncResult(overrides = {}) {
    return {
      sourceId: 7,
      sourceName: 'acme',
      status: 'success',
      commitsCount: 3,
      eventsCount: 1,
      branches: [
        { name: 'main', status: 'success', commitsCount: 3 },
        { name: 'dev', status: 'success', commitsCount: 0 },
      ],
      ...overrides,
    }
  }

  function syncStub({ get = source(), patch, post }) {
    return stub((request) => {
      if (request.method === 'PATCH') return patch ?? { status: 200, body: get }
      if (request.method === 'POST' && request.url === '/api/collect/git-remote/sync') return post ?? { status: 200, body: { result: syncResult() } }
      if (/^\/api\/collect\/sources\/\d+$/.test(request.url)) return { status: 200, body: get }
      return { status: 200, body: { sources: [get], total: 1 } }
    })
  }

  it('reads the source first, then triggers the sync and prints summary + branch lines', async () => {
    const server = await syncStub({})

    const result = await runWrp(['sources', 'sync', '7'], { stub: server })

    expect(result.code).toBe(0)
    const byId = server.requests.filter((request) => request.method === 'GET')
    expect(byId[0].url).toBe('/api/collect/sources/7')
    const post = server.requests.find((request) => request.method === 'POST')
    expect(post.url).toBe('/api/collect/git-remote/sync')
    expect(JSON.parse(post.body)).toEqual({ sourceId: 7 })
    expect(result.stdout).toContain('✓ source synced: #7 acme — 3 commits scanned, 1 new events')
    expect(result.stdout).toContain('  main: ✓ 3 commits')
    expect(result.stdout).toContain('  dev: ✓ 0 commits')
  })

  it('resolves a name or alias through the list endpoint, reusing <ref> resolution', async () => {
    const server = await syncStub({})

    const result = await runWrp(['sources', 'sync', 'acme-local'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toContain('/api/collect/sources?')
    expect(JSON.parse(server.requests.find((request) => request.method === 'POST').body)).toEqual({ sourceId: 7 })
    expect(result.stdout).toContain('✓ source synced: #7 acme')
  })

  it('PATCHes enabled+status before syncing with --enable', async () => {
    const server = await syncStub({ get: source({ enabled: false, status: 'disabled' }) })

    const result = await runWrp(['sources', 'sync', '7', '--enable'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests.map((request) => request.method)).toEqual(['GET', 'PATCH', 'POST'])
    const patch = server.requests[1]
    expect(patch.url).toBe('/api/collect/sources/7')
    expect(JSON.parse(patch.body)).toEqual({ enabled: true, status: 'enabled' })
    expect(server.requests[2].url).toBe('/api/collect/git-remote/sync')
    expect(JSON.parse(server.requests[2].body)).toEqual({ sourceId: 7 })
  })

  it('turns a 409 SOURCE_BUSY into an envelope with the retry hint', async () => {
    const server = await syncStub({
      post: { status: 409, body: { error: '该仓库正在操作中，请稍后重试', code: 'SOURCE_BUSY' } },
    })

    const result = await runWrp(['sources', 'sync', '7'], { stub: server })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(409)
    expect(error.code).toBe('SOURCE_BUSY')
    expect(error.message).toBe('该仓库正在操作中，请稍后重试')
    expect(error.fix).toContain('retry in a few seconds')
  })

  it('names the auto-disable and the path fix when the source vanished mid-sync', async () => {
    const server = await syncStub({
      post: {
        status: 500,
        body: {
          error: '同步失败',
          code: 'SYNC_FAILED',
          result: syncResult({ status: 'failed', error: '未配置邮箱', autoDisabled: true, branches: undefined }),
        },
      },
    })

    const result = await runWrp(['sources', 'sync', '7'], { stub: server })

    expect(result.code).toBe(1)
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(500)
    expect(error.code).toBe('SYNC_FAILED')
    expect(error.message).toContain('auto-disabled')
    expect(error.message).toContain('未配置邮箱')
    expect(error.fix).toContain('wrp sources update 7 --path')
  })

  it('lists the failed branches on other SYNC_FAILED outcomes', async () => {
    const server = await syncStub({
      post: {
        status: 500,
        body: {
          error: '同步失败',
          code: 'SYNC_FAILED',
          result: syncResult({
            status: 'failed',
            error: 'push rejected',
            branches: [
              { name: 'main', status: 'failed', error: 'push rejected' },
              { name: 'dev', status: 'success', commitsCount: 2 },
            ],
          }),
        },
      },
    })

    const result = await runWrp(['sources', 'sync', '7'], { stub: server })

    expect(result.code).toBe(1)
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(500)
    expect(error.code).toBe('SYNC_FAILED')
    expect(error.message).toContain('sync failed for #7 acme')
    expect(error.message).toContain('push rejected')
    expect(error.fix).toContain('failed branches: main: push rejected')
    expect(error.fix).not.toContain('dev:')
  })
})
