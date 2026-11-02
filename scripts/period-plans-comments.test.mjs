// Behaviour tests for the plan-item comment commands.
//
// The seam is the CLI: each script is spawned as a real node process against a
// stub HTTP server, so the tests observe what an agent actually gets - the
// request the script sends and the text it prints - without reaching into
// helpers or the API implementation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const SCRIPT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'period-plans',
  'scripts',
)

let server
let baseUrl
let requests
let respond

beforeEach(async () => {
  requests = []
  respond = (_req) => ({ status: 200, body: {} })
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })
    const { status, body: payload } = respond({ method: req.method, url: req.url, body })
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function runScript(script, args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(SCRIPT_DIR, script), ...args],
      {
        env: {
          ...process.env,
          WEEKLY_REPORTER_BASE_URL: baseUrl,
          WEEKLY_REPORTER_PAT: 'wrp_test_token',
        },
      },
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

function chainComment(overrides) {
  return {
    id: 7,
    planItemId: 9,
    content: 'Original blocker',
    author: 'period-plans/claude-code',
    createdAt: '2026-10-13T09:00:00.000Z',
    sourcePeriod: {
      scope: 'week',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      monthKey: null,
      label: 'Week 2026-10-12 - 2026-10-18',
    },
    ...overrides,
  }
}

describe('list-comments.mjs', () => {
  it('lists chain comments with source-period labels and authors', async () => {
    respond = () => ({
      status: 200,
      body: {
        commentCount: 2,
        comments: [
          chainComment(),
          chainComment({
            id: 8,
            planItemId: 12,
            content: 'Successor follow-up',
            author: null,
            createdAt: '2026-10-20T09:00:00.000Z',
            sourcePeriod: {
              scope: 'week',
              periodStart: '2026-10-19',
              periodEnd: '2026-10-25',
              monthKey: null,
              label: 'Week 2026-10-19 - 2026-10-25',
            },
          }),
        ],
      },
    })

    const result = await runScript('list-comments.mjs', ['12'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Plan item %12: 2 comments')
    expect(result.stdout).toContain(
      '  #7 %9 [2026-10-13 09:00 UTC] [period-plans/claude-code] [Week 2026-10-12 - 2026-10-18] Original blocker',
    )
    expect(result.stdout).toContain(
      '  #8 %12 [2026-10-20 09:00 UTC] [user] [Week 2026-10-19 - 2026-10-25] Successor follow-up',
    )
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe('/api/plan-items/12/comments')
    expect(requests[0].headers.authorization).toBe('Bearer wrp_test_token')
    expect(requests[0].headers['x-weekly-reporter-agent']).toMatch(/^period-plans\//)
  })

  it('prints an explicit empty-state line', async () => {
    respond = () => ({ status: 200, body: { commentCount: 0, comments: [] } })

    const result = await runScript('list-comments.mjs', ['12'])

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('No comments on plan item %12.')
  })

  it('reports a missing plan item and exits non-zero', async () => {
    respond = () => ({ status: 404, body: { error: 'Plan item not found' } })

    const result = await runScript('list-comments.mjs', ['999'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Plan item not found')
  })

  it('rejects a missing item id before calling the API', async () => {
    const result = await runScript('list-comments.mjs', [])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('item ID')
    expect(requests).toHaveLength(0)
  })
})

describe('add-comment.mjs', () => {
  it('posts the content and prints the created comment', async () => {
    respond = () => ({
      status: 201,
      body: chainComment({ id: 21, planItemId: 12, content: 'blocked by @17', author: null }),
    })

    const result = await runScript('add-comment.mjs', ['12', '--text', 'blocked by @17'])

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ Comment #21 added to %12 (author: user)')
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('/api/plan-items/12/comments')
    expect(JSON.parse(requests[0].body)).toEqual({ content: 'blocked by @17' })
    expect(requests[0].headers['x-weekly-reporter-agent']).toMatch(/^period-plans\//)
  })

  it('rejects missing content before calling the API', async () => {
    const result = await runScript('add-comment.mjs', ['12'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--text')
    expect(requests).toHaveLength(0)
  })

  it('rejects blank content before calling the API', async () => {
    const result = await runScript('add-comment.mjs', ['12', '--text', '   '])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--text')
    expect(requests).toHaveLength(0)
  })

  it('reports a missing plan item and exits non-zero', async () => {
    respond = () => ({ status: 404, body: { error: 'Plan item not found' } })

    const result = await runScript('add-comment.mjs', ['999', '--text', 'note'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Plan item not found')
  })
})

describe('delete-comment.mjs', () => {
  it('deletes through the owning plan item and prints the result', async () => {
    respond = () => ({ status: 200, body: { deleted: true } })

    const result = await runScript('delete-comment.mjs', ['12', '7'])

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ Comment #7 deleted from %12')
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('DELETE')
    expect(requests[0].url).toBe('/api/plan-items/12/comments/7')
  })

  it('reports a comment that is not on the item', async () => {
    respond = () => ({ status: 404, body: { error: 'Comment not found' } })

    const result = await runScript('delete-comment.mjs', ['12', '7'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Comment not found')
  })

  it('rejects a missing comment id before calling the API', async () => {
    const result = await runScript('delete-comment.mjs', ['12'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('comment ID')
    expect(requests).toHaveLength(0)
  })
})
