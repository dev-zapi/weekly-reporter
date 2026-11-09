// Behaviour tests for `wrp sources` (ticket #124).
//
// One seam only: the real CLI as a subprocess against a stub HTTP server. The
// tests assert the requests the client sends (especially the update backfill
// body), the lines it prints, and its exit codes.

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

function remoteSource(overrides = {}) {
  return source({
    id: 9,
    type: 'git-remote-github',
    name: 'gh',
    config: {
      owner: 'acme-org',
      repo: 'widgets',
      token: '[ENCRYPTED]',
      authorEmails: ['a@example.com'],
      aliases: ['gh-alias'],
      branches: ['main', 'dev'],
      branchCursors: [
        { name: 'main', lastCommitTime: '2026-09-01T10:00:00.000Z' },
        { name: 'dev', lastCommitTime: '2026-09-02T10:00:00.000Z' },
      ],
    },
    ...overrides,
  })
}

function query(url) {
  return Object.fromEntries(new URL(url, 'http://x').searchParams)
}

describe('wrp sources list', () => {
  it('applies all five filters and prints one line per source plus the footer', async () => {
    const server = await stub(() => ({
      status: 200,
      body: { sources: [source()], total: 1, page: 1, pageSize: 100 },
    }))

    const result = await runWrp(
      ['sources', 'list', '--name', 'acme', '--type', 'git-local', '--status', 'enabled', '--scope', 'work', '--sync', 'success'],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(query(server.requests[0].url)).toEqual({
      pageSize: '100',
      name: 'acme',
      type: 'git-local',
      sourceStatus: 'enabled',
      projectScope: 'work',
      syncStatus: 'success',
      page: '1',
    })
    expect(result.stdout).toContain(
      '#7 [git-local] [work] [enabled] acme (alias: acme-local) — 2 emails, 1 branches, sync 2026-11-07 10:00',
    )
    expect(result.stdout).toContain('— 1 source(s) (work 1 / personal 0)')
  })

  it('prints an explicit empty state and no footer when nothing matches', async () => {
    const server = await stub(() => ({ status: 200, body: { sources: [], total: 0 } }))
    const result = await runWrp(['sources', 'list'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('No collect sources match.')
    expect(result.stdout).not.toContain('— 0 source(s)')
  })

  it('rejects an invalid filter before any request', async () => {
    const server = await stub()
    const result = await runWrp(['sources', 'list', '--status', 'alive'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ invalid --status')
    expect(result.stderr).toContain('enabled, disabled, unavailable')
    expect(server.requests).toHaveLength(0)
  })

  it('shows the branch mode and never-synced marker', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        sources: [
          source({
            id: 3,
            type: 'git-remote-github',
            name: 'remote',
            config: { owner: 'org', repo: 'r', authorEmails: ['a@example.com'] },
            projectScope: 'personal',
            lastSyncAt: null,
            lastSyncStatus: null,
          }),
        ],
        total: 1,
      },
    }))
    const result = await runWrp(['sources', 'list'], { stub: server })

    expect(result.stdout).toContain(
      '#3 [git-remote-github] [personal] [enabled] remote — 1 emails, default-branch, never synced',
    )
  })

  it('marks a failed last sync, accepting both server spellings', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        sources: [
          source({ id: 4, name: 'legacy', lastSyncStatus: 'failure' }),
          source({ id: 5, name: 'go', lastSyncStatus: 'failed' }),
        ],
        total: 2,
      },
    }))
    const result = await runWrp(['sources', 'list'], { stub: server })

    // The Go server writes `failed`; the retired TS server wrote `failure`.
    // Either spelling must render the failure marker, not look healthy.
    expect(result.stdout).toContain(
      '#4 [git-local] [work] [enabled] legacy (alias: acme-local) — 2 emails, 1 branches, sync 2026-11-07 10:00:00 (failed)',
    )
    expect(result.stdout).toContain(
      '#5 [git-local] [work] [enabled] go (alias: acme-local) — 2 emails, 1 branches, sync 2026-11-07 10:00:00 (failed)',
    )
  })
})

describe('wrp sources show', () => {
  it('prints the full config, per-branch cursors and timestamps', async () => {
    const server = await stub((request) =>
      request.url === '/api/collect/sources/7'
        ? { status: 200, body: source() }
        : { status: 200, body: { sources: [source()], total: 1 } },
    )
    const result = await runWrp(['sources', 'show', '7'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toBe('/api/collect/sources/7')
    expect(result.stdout).toContain('#7 acme')
    expect(result.stdout).toContain('type: git-local   scope: work   status: enabled')
    expect(result.stdout).toContain('last sync: 2026-11-07 10:00:00 (success)')
    expect(result.stdout).toContain('owner: /repos/acme')
    expect(result.stdout).toContain('authorEmails (2): a@example.com, b@example.com')
    expect(result.stdout).toContain('aliases: acme-local')
    expect(result.stdout).toContain('branch main @ cursor 2026-10-01 10:00:00')
    expect(result.stdout).toContain('cursor main @ 2026-10-01 10:00:00')
    expect(result.stdout).toContain('created: 2026-01-01 00:00:00   updated: 2026-11-01 00:00:00')
  })

  it('resolves a name or alias exactly before falling back to a substring', async () => {
    const sibling = source({ id: 8, name: 'acme-extra', config: { owner: '/repos/extra', authorEmails: ['c@example.com'], aliases: [] } })
    const server = await stub(() => ({ status: 200, body: { sources: [source(), sibling], total: 2 } }))

    const exact = await runWrp(['sources', 'show', 'acme-local'], { stub: server })
    expect(exact.code).toBe(0)
    expect(exact.stdout).toContain('#7 acme')

    const substring = await runWrp(['sources', 'show', 'extra'], { stub: server })
    expect(substring.code).toBe(0)
    expect(substring.stdout).toContain('#8 acme-extra')
  })

  it('lists candidates with ids when a ref is ambiguous', async () => {
    const sibling = source({ id: 8, name: 'acme-extra', config: { owner: '/repos/extra', authorEmails: ['c@example.com'], aliases: [] } })
    const server = await stub(() => ({ status: 200, body: { sources: [source(), sibling], total: 2 } }))

    const result = await runWrp(['sources', 'show', 'acme'], { stub: server })

    // `acme` is an exact match on #7, so it is not ambiguous.
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('#7 acme')

    const ambiguous = await runWrp(['sources', 'show', 'ac'], { stub: server })
    expect(ambiguous.code).not.toBe(0)
    expect(errorLines(ambiguous.stderr)).toHaveLength(1)
    expect(ambiguous.stderr).toContain("✗ 'ac' matches 2 collect sources")
    expect(ambiguous.stderr).toContain('#7 acme')
    expect(ambiguous.stderr).toContain('#8 acme-extra')
    expect(ambiguous.stderr).toContain('pass one of those IDs instead')
  })

  it('reports a missing id and a missing name as one ✗ line each', async () => {
    const server = await stub((request) =>
      request.url === '/api/collect/sources/99'
        ? { status: 404, body: { error: '采集源不存在', code: 'NOT_FOUND' } }
        : { status: 200, body: { sources: [], total: 0 } },
    )

    const byId = await runWrp(['sources', 'show', '99'], { stub: server })
    expect(byId.code).not.toBe(0)
    expect(errorLines(byId.stderr)).toHaveLength(1)
    expect(byId.stderr).toContain('✗ no collect source with ID 99')

    const byName = await runWrp(['sources', 'show', 'ghost'], { stub: server })
    expect(byName.code).not.toBe(0)
    expect(errorLines(byName.stderr)).toHaveLength(1)
    expect(byName.stderr).toContain("✗ no collect source matches 'ghost'")
  })
})

describe('wrp sources create', () => {
  it('creates a git-local source from --path and prints the ✓ line with id and name', async () => {
    const server = await stub(() => ({
      status: 201,
      body: source({ id: 12, name: 'acme-local' }),
    }))

    const result = await runWrp(
      [
        'sources', 'create',
        '--name', 'acme-local',
        '--path', '/repos/acme',
        '--email', 'a@example.com',
        '--email', 'b@example.com',
        '--alias', 'acme',
        '--scope', 'work',
      ],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/collect/sources')
    expect(JSON.parse(server.requests[0].body)).toEqual({
      type: 'git-local',
      name: 'acme-local',
      projectScope: 'work',
      config: { owner: '/repos/acme', authorEmails: ['a@example.com', 'b@example.com'] },
      aliases: ['acme'],
    })
    expect(result.stdout).toContain('✓ source created: #12 acme-local (git-local, work) — status enabled')
  })

  it('creates a remote source with owner/repo/token/baseUrl and branches', async () => {
    const server = await stub(() => ({ status: 201, body: remoteSource({ id: 13 }) }))

    const result = await runWrp(
      [
        'sources', 'create',
        '--type', 'git-remote-github',
        '--name', 'widgets',
        '--owner', 'acme-org',
        '--repo', 'widgets',
        '--token', 'ghp_secret',
        '--base-url', 'https://ghe.example.com/api/v3',
        '--email', 'a@example.com',
        '--branch', 'main',
        '--branch', 'dev',
      ],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(server.requests[0].body)).toEqual({
      type: 'git-remote-github',
      name: 'widgets',
      projectScope: 'personal',
      config: {
        owner: 'acme-org',
        repo: 'widgets',
        token: 'ghp_secret',
        baseUrl: 'https://ghe.example.com/api/v3',
        authorEmails: ['a@example.com'],
        branches: ['main', 'dev'],
      },
    })
    expect(result.stdout).toContain('✓ source created: #13 gh (git-remote-github, work)')
  })

  it('validates type, name length, emails and the remote-required flags before any request', async () => {
    const server = await stub()

    const badType = await runWrp(['sources', 'create', '--type', 'svn', '--name', 'x', '--path', '/r', '--email', 'a@b'], { stub: server })
    expect(badType.code).not.toBe(0)
    expect(badType.stderr).toContain("✗ invalid --type: 'svn'")

    const longName = await runWrp(['sources', 'create', '--name', 'x'.repeat(101), '--path', '/r', '--email', 'a@b'], { stub: server })
    expect(longName.code).not.toBe(0)
    expect(longName.stderr).toContain('✗ invalid --name: 101 characters')
    expect(longName.stderr).toContain('at most 100')

    const noEmails = await runWrp(['sources', 'create', '--name', 'x', '--path', '/r'], { stub: server })
    expect(noEmails.code).not.toBe(0)
    expect(noEmails.stderr).toContain('✗ missing --email')
    expect(noEmails.stderr).toContain('at least one author email is required')

    const badEmail = await runWrp(['sources', 'create', '--name', 'x', '--path', '/r', '--email', 'nope'], { stub: server })
    expect(badEmail.code).not.toBe(0)
    expect(badEmail.stderr).toContain("✗ invalid --email: 'nope'")

    const noPath = await runWrp(['sources', 'create', '--name', 'x', '--email', 'a@b'], { stub: server })
    expect(noPath.code).not.toBe(0)
    expect(noPath.stderr).toContain('✗ missing --path')

    const remoteMissing = await runWrp(
      ['sources', 'create', '--type', 'git-remote-gitlab', '--name', 'x', '--owner', 'o', '--email', 'a@b'],
      { stub: server },
    )
    expect(remoteMissing.code).not.toBe(0)
    expect(remoteMissing.stderr).toContain('✗ missing --repo, --token')
    expect(remoteMissing.stderr).toContain('git-remote-gitlab')

    const pathOnRemote = await runWrp(
      ['sources', 'create', '--type', 'git-remote-gitee', '--name', 'x', '--path', '/r', '--email', 'a@b'],
      { stub: server },
    )
    expect(pathOnRemote.code).not.toBe(0)
    expect(pathOnRemote.stderr).toContain('✗ --path applies to git-local only')

    expect(server.requests).toHaveLength(0)
  })

  it('passes a server rejection through verbatim', async () => {
    const server = await stub(() => ({
      status: 400,
      body: { error: '别名已被使用: acme', code: 'DUPLICATE_ALIAS' },
    }))
    const result = await runWrp(['sources', 'create', '--name', 'x', '--path', '/r', '--email', 'a@b', '--alias', 'acme'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ DUPLICATE_ALIAS: 别名已被使用: acme')
  })
})

describe('wrp sources update', () => {
  /**
   * Answers the by-id GET that ref resolution makes plus the list endpoint the
   * name path uses, and echoes `updated` for the write.
   */
  function updateStub(current, { updated = current, writeStatus = 200 } = {}) {
    return stub((request) => {
      if (request.method === 'PUT') return { status: writeStatus, body: updated }
      if (/^\/api\/collect\/sources\/\d+$/.test(request.url)) return { status: 200, body: current }
      return { status: 200, body: { sources: [current], total: 1 } }
    })
  }

  it('backfills every unnamed field and never sends cursors or the stored token', async () => {
    const current = remoteSource()
    const server = await updateStub(current, { updated: { ...current, name: 'renamed' } })

    const result = await runWrp(['sources', 'update', 'gh', '--name', 'renamed'], { stub: server })

    expect(result.code).toBe(0)
    const put = server.requests.find((request) => request.method === 'PUT')
    expect(put.url).toBe('/api/collect/sources/9')
    const body = JSON.parse(put.body)
    expect(body).toEqual({
      type: 'git-remote-github',
      name: 'renamed',
      projectScope: 'work',
      aliases: ['gh-alias'],
      config: {
        owner: 'acme-org',
        repo: 'widgets',
        authorEmails: ['a@example.com'],
        branches: ['main', 'dev'],
      },
    })
    // The masked token and the sync cursors must never round-trip into a body.
    expect(put.body).not.toContain('[ENCRYPTED]')
    expect(body.config.token).toBeUndefined()
    expect(body.config.branchCursors).toBeUndefined()
    expect(result.stdout).toContain('✓ source updated: #9 renamed — changed: name')
  })

  it('keeps an explicit --token in the body and reports it as changed', async () => {
    const server = await updateStub(remoteSource())
    const result = await runWrp(['sources', 'update', '9', '--token', 'ghp_new'], { stub: server })

    expect(result.code).toBe(0)
    const body = JSON.parse(server.requests.find((request) => request.method === 'PUT').body)
    expect(body.config.token).toBe('ghp_new')
    expect(result.stdout).toContain('changed: token')
  })

  it('replaces the email list for --email and appends (case-insensitively) for --add-email', async () => {
    const server = await updateStub(source())

    const replaced = await runWrp(['sources', 'update', '7', '--email', 'z@example.com'], { stub: server })
    expect(replaced.code).toBe(0)
    let body = JSON.parse(server.requests.find((request) => request.method === 'PUT').body)
    expect(body.config.authorEmails).toEqual(['z@example.com'])

    const appended = await runWrp(
      ['sources', 'update', '7', '--add-email', 'A@Example.com', '--add-email', 'c@example.com'],
      { stub: server },
    )
    expect(appended.code).toBe(0)
    body = JSON.parse(server.requests.filter((request) => request.method === 'PUT')[1].body)
    expect(body.config.authorEmails).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    expect(appended.stdout).toContain('changed: emails')
  })

  it('replaces the alias list for --alias and appends for --add-alias', async () => {
    const server = await updateStub(source())

    const replaced = await runWrp(['sources', 'update', '7', '--alias', 'only'], { stub: server })
    expect(replaced.code).toBe(0)
    let body = JSON.parse(server.requests.find((request) => request.method === 'PUT').body)
    expect(body.aliases).toEqual(['only'])

    const appended = await runWrp(['sources', 'update', '7', '--add-alias', 'third'], { stub: server })
    expect(appended.code).toBe(0)
    body = JSON.parse(server.requests.filter((request) => request.method === 'PUT')[1].body)
    expect(body.aliases).toEqual(['acme-local', 'third'])
    expect(appended.stdout).toContain('changed: aliases')
  })

  it('replaces branches and warns that dropped or renamed branches lose their cursors', async () => {
    const server = await updateStub(source())

    const dropped = await runWrp(['sources', 'update', '7', '--branch', 'dev'], { stub: server })
    expect(dropped.code).toBe(0)
    const body = JSON.parse(server.requests.find((request) => request.method === 'PUT').body)
    expect(body.config.branches).toEqual(['dev'])
    expect(dropped.stdout).toContain('⚠ branches no longer in the list lose their sync cursors')
    expect(dropped.stdout).toContain('a renamed branch starts from scratch')

    const kept = await runWrp(['sources', 'update', '7', '--branch', 'main'], { stub: server })
    expect(kept.code).toBe(0)
    expect(kept.stdout).not.toContain('lose their sync cursors')
  })

  it('omits branches entirely when the source has none, keeping the all-branches sentinel', async () => {
    const bare = source({ config: { owner: '/repos/acme', authorEmails: ['a@example.com'] } })
    const server = await updateStub(bare)

    const result = await runWrp(['sources', 'update', '7', '--scope', 'personal'], { stub: server })

    expect(result.code).toBe(0)
    const body = JSON.parse(server.requests.find((request) => request.method === 'PUT').body)
    expect(body.projectScope).toBe('personal')
    expect(body).not.toHaveProperty('config.branches')
  })

  it('refuses an empty change set and the replace/append conflicts before any request', async () => {
    const server = await updateStub(source())

    const nothing = await runWrp(['sources', 'update', '7'], { stub: server })
    expect(nothing.code).not.toBe(0)
    expect(nothing.stderr).toContain('✗ nothing to update')
    expect(nothing.stderr).toContain('pass at least one field')

    const both = await runWrp(['sources', 'update', '7', '--email', 'x@y', '--add-email', 'z@y'], { stub: server })
    expect(both.code).not.toBe(0)
    expect(both.stderr).toContain('✗ --email and --add-email are exclusive')

    const bothAliases = await runWrp(['sources', 'update', '7', '--alias', 'x', '--add-alias', 'z'], { stub: server })
    expect(bothAliases.code).not.toBe(0)
    expect(bothAliases.stderr).toContain('✗ --alias and --add-alias are exclusive')

    const bothOwners = await runWrp(['sources', 'update', '7', '--path', '/a', '--owner', 'b'], { stub: server })
    expect(bothOwners.code).not.toBe(0)
    expect(bothOwners.stderr).toContain('✗ --path and --owner are synonyms')

    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
  })

  it('refuses to empty the email list', async () => {
    const current = source({ config: { owner: '/repos/acme', authorEmails: [] } })
    const server = await updateStub(current)

    const result = await runWrp(['sources', 'update', '7', '--name', 'still-empty'], { stub: server })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('✗ no author email to send')
    expect(result.stderr).toContain('--add-email')
  })
})

describe('wrp sources enable', () => {
  it('sends enabled and status together on enable and on --off', async () => {
    const current = source()
    const server = await stub((request) => {
      if (request.method === 'PATCH') return { status: 200, body: current }
      if (/^\/api\/collect\/sources\/\d+$/.test(request.url)) return { status: 200, body: current }
      return { status: 200, body: { sources: [current], total: 1 } }
    })

    const on = await runWrp(['sources', 'enable', '7'], { stub: server })
    expect(on.code).toBe(0)
    const patch = server.requests.find((request) => request.method === 'PATCH')
    expect(patch.url).toBe('/api/collect/sources/7')
    expect(JSON.parse(patch.body)).toEqual({ enabled: true, status: 'enabled' })
    expect(on.stdout).toContain('✓ source enabled: #7 acme')

    const off = await runWrp(['sources', 'enable', '7', '--off'], { stub: server })
    expect(off.code).toBe(0)
    expect(JSON.parse(server.requests.filter((request) => request.method === 'PATCH')[1].body)).toEqual({
      enabled: false,
      status: 'disabled',
    })
    expect(off.stdout).toContain('✓ source disabled: #7 acme')
  })

  it('refuses to enable an unavailable source with the fix hints and no request', async () => {
    const broken = source({ id: 5, name: 'broken', status: 'unavailable', config: { owner: '/gone', authorEmails: [] } })
    const server = await stub(() => ({ status: 200, body: { sources: [broken], total: 1 } }))

    const result = await runWrp(['sources', 'enable', 'broken'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ #5 broken is unavailable')
    expect(result.stderr).toContain('enabling it now would not fix the cause')
    expect(result.stderr).toContain('wrp sources update 5 --add-email <address>')
    expect(server.requests.filter((request) => request.method === 'PATCH')).toHaveLength(0)
  })

  it('allows disabling an unavailable source', async () => {
    const broken = source({ id: 5, name: 'broken', status: 'unavailable' })
    const server = await stub((request) => {
      if (request.method === 'PATCH') return { status: 200, body: { ...broken, status: 'disabled', enabled: false } }
      if (/^\/api\/collect\/sources\/\d+$/.test(request.url)) return { status: 200, body: broken }
      return { status: 200, body: { sources: [broken], total: 1 } }
    })

    const result = await runWrp(['sources', 'enable', '5', '--off'], { stub: server })

    expect(result.code).toBe(0)
    expect(JSON.parse(server.requests.find((request) => request.method === 'PATCH').body)).toEqual({
      enabled: false,
      status: 'disabled',
    })
  })
})

describe('wrp sources delete', () => {
  it('prints the preview and exits non-zero without --confirm', async () => {
    const server = await stub(() => ({ status: 200, body: { sources: [source()], total: 1 } }))

    const result = await runWrp(['sources', 'delete', 'acme'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)
    expect(errorLines(result.stderr)).toHaveLength(0)
    expect(result.stdout).toContain('PLAN:')
    expect(result.stdout).toContain('#7 acme (git-local, work)')
    expect(result.stdout).toContain('owner: /repos/acme')
    expect(result.stdout).toContain('2 emails, last sync success')
    expect(result.stdout).toContain('Events already collected stay on the timeline (they move to the "other" group)')
    expect(result.stdout).toContain('NOT EXECUTED — re-run with --confirm')
  })

  it('deletes with --confirm and prints the ✓ line', async () => {
    const current = source()
    const server = await stub((request) => {
      if (request.method === 'DELETE') return { status: 200, body: { success: true } }
      if (/^\/api\/collect\/sources\/\d+$/.test(request.url)) return { status: 200, body: current }
      return { status: 200, body: { sources: [current], total: 1 } }
    })

    const result = await runWrp(['sources', 'delete', '7', '--confirm'], { stub: server })

    expect(result.code).toBe(0)
    const del = server.requests.find((request) => request.method === 'DELETE')
    expect(del.url).toBe('/api/collect/sources/7')
    expect(result.stdout).toContain('✓ source deleted: #7 acme')
  })
})

describe('wrp sources help', () => {
  it('renders the built verbs without a not-implemented note', async () => {
    const moduleHelp = await runWrp(['sources', '--help'])
    expect(moduleHelp.code).toBe(0)
    expect(moduleHelp.stdout).toContain('wrp sources update')
    expect(moduleHelp.stdout).not.toContain('Not implemented')

    const commandHelp = await runWrp(['sources', 'update', '--help'])
    expect(commandHelp.code).toBe(0)
    expect(commandHelp.stdout).toContain('--add-email')
    expect(commandHelp.stdout).toContain('--base-url')
    expect(commandHelp.stdout).not.toContain('Not implemented')
  })
})

describe('sources help after #128', () => {
  it('renders lookup, emails and sync as built verbs without a not-implemented note', async () => {
    const moduleHelp = await runWrp(['sources', '--help'])
    expect(moduleHelp.code).toBe(0)
    expect(moduleHelp.stdout).toContain('wrp sources lookup')
    expect(moduleHelp.stdout).toContain('wrp sources emails')
    expect(moduleHelp.stdout).toContain('wrp sources sync')
    expect(moduleHelp.stdout).not.toContain('Not implemented')

    for (const verb of ['lookup', 'emails', 'sync']) {
      const commandHelp = await runWrp(['sources', verb, '--help'])
      expect(commandHelp.code).toBe(0)
      expect(commandHelp.stdout).toContain(`wrp sources ${verb}`)
      expect(commandHelp.stdout).not.toContain('Not implemented')
    }
  })
})
