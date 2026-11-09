// Behaviour tests for the wrp events module (#122).
//
// The seam is the CLI: `wrp events <verb>` runs as a real subprocess against a
// stub HTTP server, so each test observes what an agent actually gets - the
// request the client sends and the lines it prints.
//
// Expected lines are written out as literals (the format laws of spec #119),
// never recomputed from the implementation.

import { describe, it, expect, afterEach } from 'vitest'
import { errorLines, runWrp, startStubServer } from './wrp-cli-harness.mjs'

const stubs = []

async function stub(respond) {
  const server = await startStubServer(respond)
  stubs.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

const PAT = 'wrp_test_token'

function run(args, server, env = {}) {
  return runWrp(args, { stub: server, env: { WEEKLY_REPORTER_PAT: PAT, ...env } })
}

/** Query parameters of one received request, as a plain object. */
function params(request) {
  return Object.fromEntries(new URL(request.url, 'http://stub').searchParams)
}

function event(overrides = {}) {
  return {
    id: 6991,
    eventTime: '2026-11-09T14:02:00.000Z',
    source: 'manual',
    content: 'fixed login timeout and added regression tests',
    metadata: { tags: ['工作', '个人'] },
    category: null,
    isImportant: false,
    createdAt: '2026-11-09T14:02:00.000Z',
    updatedAt: '2026-11-09T14:02:00.000Z',
    ...overrides,
  }
}

describe('wrp events list', () => {
  it('sends every filter as a query parameter', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [], hasMore: false } }))

    await run(
      [
        'events', 'list',
        '--date', '2026-11-09',
        '--week-start', '2026-11-09',
        '--week-end', '2026-11-15',
        '--tags', '工作,个人',
        '--source', 'manual',
        '--limit', '5',
      ],
      server,
    )

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(params(server.requests[0])).toEqual({
      date: '2026-11-09',
      weekStart: '2026-11-09',
      weekEnd: '2026-11-15',
      tags: '工作,个人',
      source: 'manual',
      limit: '5',
    })
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${PAT}`)
  })

  it('sends no query string at all when no filter is passed', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [], hasMore: false } }))

    await run(['events', 'list'], server)

    expect(server.requests[0].url).toBe('/api/events')
  })

  it('prints one id-first line per event plus the count footer', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        events: [
          event(),
          event({
            id: 6992,
            eventTime: '2026-11-09T15:30:00.000Z',
            source: 'auto',
            content: 'chore: cutover to the Go single binary',
            metadata: null,
            isImportant: true,
          }),
        ],
        hasMore: false,
      },
    }))

    const result = await run(['events', 'list', '--date', '2026-11-09'], server)

    expect(result.code).toBe(0)
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([
      '#6991 [2026-11-09 14:02] [manual] fixed login timeout and added regression tests #工作 #个人',
      '#6992 [2026-11-09 15:30] [auto] ★ chore: cutover to the Go single binary',
      '— 2 event(s)',
    ])
  })

  it('appends the cursor hint when more pages exist', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        events: [event()],
        hasMore: true,
        nextCursor: { id: 6991, eventTime: Date.parse('2026-11-09T14:02:00.000Z') },
      },
    }))

    const result = await run(['events', 'list', '--limit', '1'], server)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('— 1 event(s)')
    expect(result.stdout).toContain('next page: --cursor 6991@1794232920000')
  })

  it('sends the cursor back as cursorId and cursorTime', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [], hasMore: false } }))

    await run(['events', 'list', '--cursor', '6991@1794232920000'], server)

    expect(params(server.requests[0])).toEqual({
      cursorId: '6991',
      cursorTime: '1794232920000',
    })
  })

  it('rejects a malformed cursor before calling the API', async () => {
    const server = await stub()

    const result = await run(['events', 'list', '--cursor', 'nonsense'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ invalid cursor: nonsense')
    expect(server.requests).toHaveLength(0)
  })

  it('prints an explicit empty state without a footer', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [], hasMore: false } }))

    const result = await run(['events', 'list', '--date', '2026-11-09'], server)

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(
      'No events found — widen the filters (--date, --week-start/--week-end, --tags).',
    )
  })

  it('surfaces an API failure as one ✗ line with a fix hint', async () => {
    const server = await stub(() => ({ status: 400, body: { error: '无效的日期格式' } }))

    const result = await run(['events', 'list', '--date', 'nope'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ request failed (HTTP 400): 无效的日期格式 → ')
    expect(result.stderr).toContain('--date')
  })
})

describe('wrp events create', () => {
  it('posts the content and prints the created id', async () => {
    const server = await stub(() => ({ status: 201, body: event({ id: 7001 }) }))

    const result = await run(['events', 'create', 'fix login timeout #工作'], server)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('✓ event created: #7001\n')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/events')
    expect(server.requests[0].headers['content-type']).toBe('application/json')
    expect(JSON.parse(server.requests[0].body)).toEqual({ content: 'fix login timeout #工作' })
  })

  it('honours --time by sending eventTime', async () => {
    const server = await stub(() => ({ status: 200, body: event({ id: 7002 }) }))

    const result = await run(
      ['events', 'create', 'wrote the ADR', '--time', '2026-11-08T09:30:00+08:00'],
      server,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('✓ event created: #7002\n')
    expect(JSON.parse(server.requests[0].body)).toEqual({
      content: 'wrote the ADR',
      eventTime: '2026-11-08T09:30:00+08:00',
    })
  })

  it('requires content and never calls the API without it', async () => {
    const server = await stub()

    const result = await run(['events', 'create'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ missing content')
    expect(result.stderr).toContain('wrp events create')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a second positional argument instead of dropping it', async () => {
    const server = await stub()

    const result = await run(['events', 'create', 'one', 'two'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ unexpected argument: two')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces a rejected payload as one ✗ line with a fix hint', async () => {
    const server = await stub(() => ({ status: 400, body: { error: 'content 不能为空' } }))

    const result = await run(['events', 'create', 'x'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ request failed (HTTP 400): content 不能为空 → ')
    expect(result.stderr).toContain('single-line')
  })
})

describe('wrp events update', () => {
  it('puts the changed fields and prints the feedback line', async () => {
    const server = await stub(() => ({ status: 200, body: event() }))

    const result = await run(
      ['events', 'update', '6991', '--content', 'fixed login timeout @6990 #工作', '--important', 'true'],
      server,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('✓ event updated: #6991\n')
    expect(server.requests[0].method).toBe('PUT')
    expect(server.requests[0].url).toBe('/api/events/6991')
    expect(JSON.parse(server.requests[0].body)).toEqual({
      content: 'fixed login timeout @6990 #工作',
      isImportant: true,
    })
  })

  it('sends isImportant false as a real update', async () => {
    const server = await stub(() => ({ status: 200, body: event() }))

    const result = await run(['events', 'update', '6991', '--important', 'false'], server)

    expect(result.code).toBe(0)
    expect(JSON.parse(server.requests[0].body)).toEqual({ isImportant: false })
  })

  it('requires at least one field flag', async () => {
    const server = await stub()

    const result = await run(['events', 'update', '6991'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ missing change (--content | --time | --important)')
    expect(server.requests).toHaveLength(0)
  })

  it('accepts only true or false for --important', async () => {
    const server = await stub()

    const result = await run(['events', 'update', '6991', '--important', 'yes'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain("✗ invalid --important: yes")
    expect(result.stderr).toContain('true|false')
    expect(server.requests).toHaveLength(0)
  })

  it('refuses an empty --time before calling the API', async () => {
    const server = await stub()

    const result = await run(['events', 'update', '6991', '--time', ''], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ missing value for --time')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a non-numeric id before calling the API', async () => {
    const server = await stub()

    const result = await run(['events', 'update', 'abc', '--important', 'true'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ invalid event id: abc')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces a 404 as one ✗ line pointing at the list verb', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Event not found' } }))

    const result = await run(['events', 'update', '999999', '--important', 'true'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ event not found (HTTP 404): Event not found')
    expect(result.stderr).toContain('wrp events list')
  })
})

describe('wrp events delete', () => {
  it('deletes and prints the feedback line', async () => {
    const server = await stub(() => ({ status: 204, raw: '' }))

    const result = await run(['events', 'delete', '6991'], server)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('✓ event deleted: #6991\n')
    expect(server.requests[0].method).toBe('DELETE')
    expect(server.requests[0].url).toBe('/api/events/6991')
  })

  it('surfaces the 403 refusal of an auto-collected event with the git-history fix', async () => {
    const server = await stub(() => ({
      status: 403,
      body: { error: 'Cannot delete non-manual event' },
    }))

    const result = await run(['events', 'delete', '6992'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain(
      '✗ delete refused (HTTP 403): Cannot delete non-manual event → ',
    )
    expect(result.stderr).toContain('git history')
  })

  it('surfaces a 404 as one ✗ line pointing at the list verb', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Event not found' } }))

    const result = await run(['events', 'delete', '999999'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ event not found (HTTP 404): Event not found')
    expect(result.stderr).toContain('wrp events list')
  })

  it('requires an id and never calls the API without it', async () => {
    const server = await stub()

    const result = await run(['events', 'delete'], server)

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ missing event id')
    expect(server.requests).toHaveLength(0)
  })
})

describe('wrp events help', () => {
  it('lists the four verbs instead of a not-implemented note', async () => {
    const result = await runWrp(['events', '--help'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('wrp events list')
    expect(result.stdout).toContain('wrp events create')
    expect(result.stdout).toContain('wrp events update')
    expect(result.stdout).toContain('wrp events delete')
    expect(result.stdout).not.toContain('Not implemented')
  })

  it('renders a built command help without the not-implemented note', async () => {
    const result = await runWrp(['events', 'list', '--help'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('wrp events list')
    expect(result.stdout).toContain('--cursor')
    expect(result.stdout).not.toContain('Not implemented')
  })
})
