// Behaviour tests for the wrp events module (#122).
//
// The seam is the CLI: `wrp events <verb>` runs as a real subprocess against a
// stub HTTP server, so each test observes what an agent actually gets - the
// request the client sends and the lines it prints.
//
// Expected output is written out as literals (the verbatim-JSON contract of
// spec #153), never recomputed from the implementation.

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

const PAT = 'wrp_test_token'

function run(args, server, env = {}) {
  // Pin the zone so output assertions never depend on the host machine's TZ.
  return runWrp(args, { stub: server, env: { WEEKLY_REPORTER_PAT: PAT, TZ: 'UTC', ...env } })
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
      date: '2026-11-09T00:00:00+00:00',
      weekStart: '2026-11-09T00:00:00+00:00',
      weekEnd: '2026-11-15T00:00:00+00:00',
      tags: '工作,个人',
      source: 'manual',
      limit: '5',
    })
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${PAT}`)
  })

  it('expands date flags to system-zone midnight while preserving the offset', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [], hasMore: false } }))

    await run(
      [
        'events', 'list',
        '--date', '2026-11-09',
        '--week-start', '2026-11-09',
        '--week-end', '2026-11-15',
      ],
      server,
      { TZ: 'Asia/Shanghai' },
    )

    expect(params(server.requests[0])).toEqual({
      date: '2026-11-09T00:00:00+08:00',
      weekStart: '2026-11-09T00:00:00+08:00',
      weekEnd: '2026-11-15T00:00:00+08:00',
    })
  })

  it('rejects a malformed date flag before calling the API', async () => {
    const server = await stub()

    const result = await run(['events', 'list', '--date', '2026-11-31'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid --date: 2026-11-31')
    expect(error.fix).toContain('YYYY-MM-DD')
    expect(server.requests).toHaveLength(0)
  })

  it('sends no query string at all when no filter is passed', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [], hasMore: false } }))

    await run(['events', 'list'], server)

    expect(server.requests[0].url).toBe('/api/events')
  })

  it('prints the API body verbatim as one compact JSON line', async () => {
    const body = {
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
    }
    const server = await stub(() => ({ status: 200, body }))

    const result = await run(['events', 'list', '--date', '2026-11-09'], server)

    expect(result.code).toBe(0)
    // Exact string: one line of compact JSON, no footer, no count line, no
    // reordering, and no additive key when there is no next page.
    expect(result.stdout).toBe(JSON.stringify(body) + '\n')
  })

  it('adds nextCursorToken when hasMore and nextCursor are present', async () => {
    const body = {
      events: [event()],
      hasMore: true,
      nextCursor: { id: 6991, eventTime: Date.parse('2026-11-09T14:02:00.000Z') },
    }
    const server = await stub(() => ({ status: 200, body }))

    const result = await run(['events', 'list', '--limit', '1'], server)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      JSON.stringify({ ...body, nextCursorToken: '6991@1794232920000' }) + '\n',
    )
  })

  it('adds no nextCursorToken when hasMore has no cursor to reassemble', async () => {
    const body = { events: [event()], hasMore: true }
    const server = await stub(() => ({ status: 200, body }))

    const result = await run(['events', 'list', '--limit', '1'], server)

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(body)
    expect(JSON.parse(result.stdout)).not.toHaveProperty('nextCursorToken')
  })

  it('adds no nextCursorToken when there is no next page despite a cursor', async () => {
    const body = {
      events: [event()],
      hasMore: false,
      nextCursor: { id: 6991, eventTime: 1794232920000 },
    }
    const server = await stub(() => ({ status: 200, body }))

    const result = await run(['events', 'list'], server)

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(body)
    expect(JSON.parse(result.stdout)).not.toHaveProperty('nextCursorToken')
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
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid cursor: nonsense')
    expect(server.requests).toHaveLength(0)
  })

  it('prints the raw body for an empty result with no prose empty-state', async () => {
    const server = await stub(() => ({ status: 200, body: { events: [] } }))

    const result = await run(['events', 'list', '--date', '2026-11-09'], server)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{"events":[]}\n')
  })

  it('surfaces an API failure as one envelope with a fix hint', async () => {
    const server = await stub(() => ({ status: 400, body: { error: '无效的日期格式' } }))

    const result = await run(['events', 'list', '--date', '2026-11-09'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(400)
    expect(error).not.toHaveProperty('code')
    expect(error.message).toBe('无效的日期格式')
    expect(error.fix).toContain('--date')
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

  it('normalizes --time to a UTC instant on the wire', async () => {
    const server = await stub(() => ({ status: 200, body: event({ id: 7002 }) }))

    const result = await run(
      ['events', 'create', 'wrote the ADR', '--time', '2026-11-08T09:30:00+08:00'],
      server,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('✓ event created: #7002\n')
    expect(JSON.parse(server.requests[0].body)).toEqual({
      content: 'wrote the ADR',
      eventTime: '2026-11-08T01:30:00.000Z',
    })
  })

  it('normalizes a Z timestamp to the canonical UTC instant', async () => {
    const server = await stub(() => ({ status: 200, body: event({ id: 7003 }) }))

    const result = await run(
      ['events', 'create', 'wrote the ADR', '--time', '2026-11-08T01:30:00Z'],
      server,
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(server.requests[0].body)).toEqual({
      content: 'wrote the ADR',
      eventTime: '2026-11-08T01:30:00.000Z',
    })
  })

  it('rejects a naive --time with the system zone and a fix example', async () => {
    const server = await stub()

    const result = await run(
      ['events', 'create', 'wrote the ADR', '--time', '2026-11-10T09:00'],
      server,
      { TZ: 'Asia/Shanghai' },
    )

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid --time: 2026-11-10T09:00')
    expect(error.message).toContain('Asia/Shanghai')
    expect(error.fix).toContain('2026-11-10T09:00:00+08:00')
    expect(error.fix).toContain('2026-11-10T09:00:00Z')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects an impossible calendar date instead of rolling it over', async () => {
    const server = await stub()

    const result = await run(
      ['events', 'create', 'wrote the ADR', '--time', '2026-11-31T09:00:00Z'],
      server,
    )

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid --time: 2026-11-31T09:00:00Z')
    expect(server.requests).toHaveLength(0)
  })

  it('requires content and never calls the API without it', async () => {
    const server = await stub()

    const result = await run(['events', 'create'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('missing content')
    expect(error.fix).toContain('wrp events create')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a second positional argument instead of dropping it', async () => {
    const server = await stub()

    const result = await run(['events', 'create', 'one', 'two'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('unexpected argument: two')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces a rejected payload as one envelope with a fix hint', async () => {
    const server = await stub(() => ({ status: 400, body: { error: 'content 不能为空' } }))

    const result = await run(['events', 'create', 'x'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(400)
    expect(error.message).toBe('content 不能为空')
    expect(error.fix).toContain('single-line')
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

  it('normalizes an offset --time to UTC on update too', async () => {
    const server = await stub(() => ({ status: 200, body: event() }))

    const result = await run(
      ['events', 'update', '6991', '--time', '2026-11-08T09:30:00+08:00'],
      server,
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(server.requests[0].body)).toEqual({
      eventTime: '2026-11-08T01:30:00.000Z',
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
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('missing change (--content | --time | --important)')
    expect(server.requests).toHaveLength(0)
  })

  it('accepts only true or false for --important', async () => {
    const server = await stub()

    const result = await run(['events', 'update', '6991', '--important', 'yes'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid --important: yes')
    expect(error.fix).toContain('true|false')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a naive --time before calling the API', async () => {
    const server = await stub()

    const result = await run(
      ['events', 'update', '6991', '--time', '2026-11-10T09:00'],
      server,
      { TZ: 'Asia/Shanghai' },
    )

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid --time: 2026-11-10T09:00')
    expect(error.message).toContain('Asia/Shanghai')
    expect(server.requests).toHaveLength(0)
  })

  it('refuses an empty --time before calling the API', async () => {
    const server = await stub()

    const result = await run(['events', 'update', '6991', '--time', ''], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('missing value for --time')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a non-numeric id before calling the API', async () => {
    const server = await stub()

    const result = await run(['events', 'update', 'abc', '--important', 'true'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('invalid event id: abc')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces a 404 as one envelope pointing at the list verb', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Event not found' } }))

    const result = await run(['events', 'update', '999999', '--important', 'true'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(404)
    expect(error.message).toBe('event not found: Event not found')
    expect(error.fix).toContain('wrp events list')
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
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(403)
    expect(error.message).toBe('delete refused: Cannot delete non-manual event')
    expect(error.fix).toContain('git history')
  })

  it('surfaces a 404 as one envelope pointing at the list verb', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Event not found' } }))

    const result = await run(['events', 'delete', '999999'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(404)
    expect(error.message).toBe('event not found: Event not found')
    expect(error.fix).toContain('wrp events list')
  })

  it('requires an id and never calls the API without it', async () => {
    const server = await stub()

    const result = await run(['events', 'delete'], server)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('missing event id')
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
