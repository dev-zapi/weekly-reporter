// Behaviour tests for the wrp tags module (#123).
//
// Same seam as the foundation and the plan-comment suite: the real `wrp` entry
// point as a subprocess against a stub HTTP server. A test observes the requests
// the client sends, the lines it prints and its exit code - never lib internals.

import { describe, it, expect, afterEach } from 'vitest'
import { runWrp, startStubServer } from './wrp-cli-harness.mjs'

/** Decode the one JSON error envelope a failing run printed on stderr. */
function errorEnvelope(result) {
  const lines = result.stderr.trimEnd().split('\n')
  return JSON.parse(lines.at(-1))
}

const ENV = { WEEKLY_REPORTER_PAT: 'wrp_test_token' }

// Deliberately unsorted: list prints whatever the API returns (the server sorts).
const TAGS = [
  { name: 'debug', count: 8 },
  { name: '调试', count: 12 },
  { name: 'worklog', count: 1 },
]

const stubs = []

async function stub(respond) {
  const server = await startStubServer(respond)
  stubs.push(server)
  return server
}

/** GET /api/tags answers the inventory; every other route falls through. */
function inventory(tags = TAGS) {
  return (request) =>
    request.method === 'GET' && request.url === '/api/tags'
      ? { status: 200, body: { tags } }
      : {}
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

describe('wrp tags list', () => {
  it('prints one line per tag with its event count, then the total footer', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'list'], { stub: server, env: ENV })

    expect(result.code).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      '#debug — 8 event(s)',
      '#调试 — 12 event(s)',
      '#worklog — 1 event(s)',
      '— 3 tag(s)',
    ])
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(server.requests[0].url).toBe('/api/tags')
  })

  it('prints the no-tags-yet hint instead of an empty footer', async () => {
    const server = await stub(inventory([]))
    const result = await runWrp(['tags', 'list'], { stub: server, env: ENV })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('No tags yet')
    expect(result.stdout).not.toContain('— 0 tag(s)')
  })
})

describe('wrp tags rename - plan gate', () => {
  it('prints the plan and exits 1 without --confirm, sending only the inventory read', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'rename', '调试', '任务'], { stub: server, env: ENV })

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('PLAN:')
    expect(result.stdout).toContain('rename #调试 → #任务 on 12 event(s)')
    expect(result.stdout).toContain('NOT EXECUTED — re-run with --confirm')
    expect(result.stdout).not.toContain('already exists')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(server.requests[0].url).toBe('/api/tags')
  })

  it('warns with the merge target event count when the target already exists', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'rename', '调试', 'debug'], { stub: server, env: ENV })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain("'#debug' already exists on 8 event(s)")
    expect(result.stdout).toContain('MERGE')
    expect(result.stdout).toContain('NOT EXECUTED — re-run with --confirm')
  })

  it('points at the list verb when the source tag does not exist', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'rename', 'missing', 'debug'], { stub: server, env: ENV })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain("no tag named '#missing'")
    expect(error.fix).toContain('wrp tags list')
    expect(server.requests).toHaveLength(1)
  })
})

describe('wrp tags rename - confirmed', () => {
  it('posts the rename and reports the merge when it happened', async () => {
    const server = await stub((request) => {
      if (request.url === '/api/tags') return { status: 200, body: { tags: TAGS } }
      if (request.url === '/api/tags/rename') {
        return { status: 200, body: { eventsUpdated: 12, merged: true } }
      }
      return {}
    })

    const result = await runWrp(['tags', 'rename', '调试', 'debug', '--confirm'], {
      stub: server,
      env: ENV,
    })

    expect(result.code).toBe(0)
    const write = server.requests.find((request) => request.method === 'POST')
    expect(write.url).toBe('/api/tags/rename')
    expect(JSON.parse(write.body)).toEqual({ from: '调试', to: 'debug' })
    expect(result.stdout.trim()).toBe(
      '✓ tag renamed: #调试 → #debug on 12 event(s), merged with the existing tag',
    )
  })

  it('omits the merge note when the target was new', async () => {
    const server = await stub((request) => {
      if (request.url === '/api/tags') return { status: 200, body: { tags: TAGS } }
      if (request.url === '/api/tags/rename') {
        return { status: 200, body: { eventsUpdated: 12, merged: false } }
      }
      return {}
    })

    const result = await runWrp(['tags', 'rename', '调试', '任务', '--confirm'], {
      stub: server,
      env: ENV,
    })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ tag renamed: #调试 → #任务 on 12 event(s)')
  })
})

describe('wrp tags remove', () => {
  it('prints the plan and exits 1 without --confirm', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'remove', '调试'], { stub: server, env: ENV })

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('PLAN:')
    expect(result.stdout).toContain('remove #调试 from 12 event(s)')
    expect(result.stdout).toContain('NOT EXECUTED — re-run with --confirm')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
  })

  it('points at the list verb when the tag does not exist', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'remove', 'missing'], { stub: server, env: ENV })

    expect(result.code).toBe(1)
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain("no tag named '#missing'")
    expect(error.fix).toContain('wrp tags list')
  })

  it('deletes with --confirm and reports the affected count', async () => {
    const server = await stub((request) => {
      if (request.url === '/api/tags') return { status: 200, body: { tags: TAGS } }
      if (request.method === 'DELETE' && request.url.startsWith('/api/tags?name=')) {
        return { status: 200, body: { removed: 12 } }
      }
      return {}
    })

    const result = await runWrp(['tags', 'remove', '调试', '--confirm'], { stub: server, env: ENV })

    expect(result.code).toBe(0)
    const write = server.requests.find((request) => request.method === 'DELETE')
    expect(write.url).toBe(`/api/tags?name=${encodeURIComponent('调试')}`)
    expect(result.stdout.trim()).toBe('✓ tag removed: #调试 from 12 event(s)')
  })
})

describe('client-side tag-name validation', () => {
  it('rejects a name containing a symbol with the charset rule in the message', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'rename', 'my-tag', 'debug'], { stub: server, env: ENV })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain("invalid tag name: 'my-tag'")
    expect(error.message).toContain('Chinese characters, Latin letters and digits')
    expect(error.message).toContain('at least one non-digit')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a digits-only name before touching the API', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'remove', '123'], { stub: server, env: ENV })

    expect(result.code).not.toBe(0)
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain("invalid tag name: '123'")
    expect(server.requests).toHaveLength(0)
  })

  it('validates the target name too, so a bad target never rewrites content', async () => {
    const server = await stub(inventory())
    const result = await runWrp(['tags', 'rename', '调试', 'bad_target'], { stub: server, env: ENV })

    expect(result.code).not.toBe(0)
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain("invalid tag name: 'bad_target'")
    expect(server.requests).toHaveLength(0)
  })
})
