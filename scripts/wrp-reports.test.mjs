// Behaviour tests for `wrp reports` (#127).
//
// Same seam as the foundation suite: the real CLI as a subprocess against a stub
// HTTP server. What is asserted is what an agent sees - the requests that reach
// the API, the lines printed, the exit code.
//
// The expectations come from the pre-merge weekly-report scripts and the
// output contract (five format laws), not from the module's own code.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** A URL's path plus parsed params, so assertions don't depend on param order. */
function parseRequest(request) {
  const url = new URL(request.url, 'http://stub')
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) }
}

function requestBody(request) {
  return request.body === '' ? null : JSON.parse(request.body)
}

const PAGED_REPORTS = {
  reports: [
    {
      id: 12,
      title: '第 7 周周报',
      weekStart: '2026-02-09',
      weekEnd: '2026-02-15',
      content: '',
      updatedAt: '2026-02-15T10:00:00Z',
      variants: [
        { variant: 'leadership', finalStatus: 'current', sourceRevision: 3 },
        { variant: 'personal', finalStatus: 'stale', sourceRevision: 3 },
      ],
    },
    {
      id: 9,
      title: '第 6 周周报',
      weekStart: '2026-02-02',
      weekEnd: '2026-02-08',
      content: '',
      updatedAt: '2026-02-08T10:00:00Z',
      variants: [
        { variant: 'leadership', finalStatus: 'none', sourceRevision: 1 },
        { variant: 'personal', finalStatus: 'none', sourceRevision: 1 },
      ],
    },
  ],
  total: 12,
  page: 1,
  pageSize: 10,
}

describe('wrp reports list', () => {
  it('pages through reports and prints each variant final status', async () => {
    const server = await stub(() => ({ status: 200, body: PAGED_REPORTS }))

    const result = await runWrp(['reports', 'list'], { stub: server })

    expect(result.code).toBe(0)
    const { path, params } = parseRequest(server.requests[0])
    expect(path).toBe('/api/reports')
    expect(params).toEqual({ page: '1', pageSize: '10' })

    // Law 2: id token, bracketed metadata, then the body - one line per report.
    const lines = result.stdout.split('\n')
    expect(lines[0]).toBe('#12 [2026-02-09~2026-02-15] [leadership:current] [personal:stale] 第 7 周周报')
    expect(lines[1]).toBe('#9 [2026-02-02~2026-02-08] [leadership:none] [personal:none] 第 6 周周报')
    expect(result.stdout).toContain('— 2 report(s)')
    // Page 1 of 2 of 12 total, and the command to reach the next page.
    expect(result.stdout).toContain('page 1/2')
    expect(result.stdout).toContain('next: --page 2')
  })

  it('says how many pages are left on the last page', async () => {
    const server = await stub(() => ({ status: 200, body: { ...PAGED_REPORTS, page: 2 } }))

    const result = await runWrp(['reports', 'list', '--page', '2'], { stub: server })

    expect(result.code).toBe(0)
    expect(parseRequest(server.requests[0]).params).toEqual({ page: '2', pageSize: '10' })
    expect(result.stdout).toContain('page 2/2')
    expect(result.stdout).not.toContain('next: --page')
  })

  it('switches to unpaginated search mode when --query is given', async () => {
    const server = await stub(() => ({ status: 200, body: { reports: [PAGED_REPORTS.reports[0]] } }))

    const result = await runWrp(['reports', 'list', '--query', 'Nexus'], { stub: server })

    expect(result.code).toBe(0)
    const { path, params } = parseRequest(server.requests[0])
    expect(path).toBe('/api/reports/search')
    expect(params).toEqual({ q: 'Nexus' })
    expect(result.stdout).toContain('[leadership:current] [personal:stale] 第 7 周周报')
    expect(result.stdout).toContain('— 1 report(s)')
    expect(result.stdout).toContain('newest first')
  })

  it('switches to search mode on a date range alone', async () => {
    const server = await stub(() => ({ status: 200, body: { reports: [] } }))

    const result = await runWrp(
      ['reports', 'list', '--start', '2026-02-01', '--end', '2026-02-28'],
      { stub: server, env: { TZ: 'Asia/Shanghai' } },
    )

    const { path, params } = parseRequest(server.requests[0])
    expect(path).toBe('/api/reports/search')
    // System-zone midnight with the offset kept on the wire - not a UTC instant.
    expect(params).toEqual({
      startDate: '2026-02-01T00:00:00+08:00',
      endDate: '2026-02-28T00:00:00+08:00',
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('No reports matched')
    // The empty state is the whole answer: no count footer and no page hint.
    expect(result.stdout).not.toContain('— 0 report(s)')
    expect(result.stdout).not.toContain('page 1/1 of 0 reports')
  })

  it('rejects a malformed date with one ✗ line and no request', async () => {
    const server = await stub()

    const result = await runWrp(['reports', 'list', '--start', '2026/02/01'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ --start must be a YYYY-MM-DD date')
    expect(server.requests).toHaveLength(0)
  })
})

const REPORT_DETAIL = {
  id: 12,
  title: '第 7 周周报',
  weekStart: '2026-02-09',
  weekEnd: '2026-02-15',
  updatedAt: '2026-02-15T10:00:00Z',
  variants: [
    {
      variant: 'leadership',
      sourceDraft: '- 2026-02-10 Nexus 上线\n- 2026-02-11 评审',
      finalContent: '# 第 7 周\n\n交付 Nexus。',
      finalStatus: 'current',
      templateName: '周报模板',
      aiStyle: 'concise',
      sourceRevision: 4,
    },
    {
      variant: 'personal',
      sourceDraft: '- 2026-02-10 Nexus 上线\n- 2026-02-11 评审\n- 2026-02-12 调休',
      finalContent: '',
      finalStatus: 'stale',
      templateName: null,
      aiStyle: null,
      sourceRevision: 4,
    },
  ],
  snapshots: [{ id: 1 }, { id: 2 }, { id: 3 }],
}

describe('wrp reports show', () => {
  it('prints metadata and per-variant sizes only, by default', async () => {
    const server = await stub(() => ({ status: 200, body: REPORT_DETAIL }))

    const result = await runWrp(['reports', 'show', '12'], { stub: server, env: { TZ: 'UTC' } })

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toBe('/api/reports/12')
    const lines = result.stdout.split('\n')
    expect(lines[0]).toBe('#12 [2026-02-09~2026-02-15] 第 7 周周报')
    expect(result.stdout).toContain('updated: 2026-02-15T10:00:00+00:00')
    expect(result.stdout).toContain('snapshots: 3 event(s)')
    expect(result.stdout).toContain('final: current')
    expect(result.stdout).toContain('template: 周报模板   style: concise   sourceRevision: 4')
    expect(result.stdout).toContain('source draft: 37 chars   final: 18 chars')
    // Law 5: no multi-line payload escapes without an explicit --part.
    expect(result.stdout).not.toContain('Nexus 上线')
    expect(result.stdout).not.toContain('交付 Nexus')
  })

  it('renders the updated timestamp in the system zone with an offset', async () => {
    const server = await stub(() => ({ status: 200, body: REPORT_DETAIL }))

    const result = await runWrp(['reports', 'show', '12'], { stub: server, env: { TZ: 'Asia/Shanghai' } })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('updated: 2026-02-15T18:00:00+08:00')
    // The period key stays date-only; only the instant carries an offset.
    expect(result.stdout).toContain('#12 [2026-02-09~2026-02-15]')
  })

  it('prints one variant draft under --variant --part draft', async () => {
    const server = await stub(() => ({ status: 200, body: REPORT_DETAIL }))

    const result = await runWrp(['reports', 'show', '12', '--variant', 'leadership', '--part', 'draft'], {
      stub: server,
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('── leadership ──')
    expect(result.stdout).not.toContain('── personal ──')
    expect(result.stdout).toContain('source draft:')
    expect(result.stdout).toContain('2026-02-10 Nexus 上线')
    expect(result.stdout).not.toContain('交付 Nexus')
    expect(result.stdout).not.toContain('调休')
  })

  it('prints both parts under --part both', async () => {
    const server = await stub(() => ({ status: 200, body: REPORT_DETAIL }))

    const result = await runWrp(['reports', 'show', '12', '--variant', 'personal', '--part', 'both'], {
      stub: server,
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('(no adopted final)')
    expect(result.stdout).toContain('调休')
    expect(result.stdout).toContain('final: stale')
    expect(result.stdout).toContain('adopted before the latest source draft')
  })

  it('accepts --part source as an alias for draft', async () => {
    const server = await stub(() => ({ status: 200, body: REPORT_DETAIL }))

    const result = await runWrp(['reports', 'show', '12', '--variant', 'leadership', '--part', 'source'], {
      stub: server,
    })

    expect(result.code).toBe(0)
    // `source` maps to the draft part: the draft body prints, the final body does not.
    expect(result.stdout).toContain('source draft:')
    expect(result.stdout).toContain('2026-02-10 Nexus 上线')
    expect(result.stdout).not.toContain('交付 Nexus')
  })

  it('rejects an unknown --part with the allowed values', async () => {
    const server = await stub()

    const result = await runWrp(['reports', 'show', '12', '--part', 'everything'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ --part must be one of meta, source, draft, final, both')
    expect(server.requests).toHaveLength(0)
  })

  it('reports a missing variant instead of printing nothing', async () => {
    const server = await stub(() => ({ status: 200, body: { ...REPORT_DETAIL, variants: [] } }))

    const result = await runWrp(['reports', 'show', '12', '--variant', 'leadership'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('✗ report #12 has no leadership variant')
  })

  it('rejects a non-numeric id (no parseInt truncation) before calling the API', async () => {
    const server = await stub()

    const result = await runWrp(['reports', 'show', '12abc'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('a numeric report id is required')
    expect(server.requests).toHaveLength(0)
  })

  it('accepts the #id token printed by wrp reports list', async () => {
    const server = await stub(() => ({ status: 200, body: REPORT_DETAIL }))

    const result = await runWrp(['reports', 'show', '#12'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toBe('/api/reports/12')
  })
})

describe('wrp reports preview', () => {
  it('prints the first 12 lines per variant with counts and creates nothing', async () => {
    const longDraft = Array.from({ length: 15 }, (_, index) => `- event ${index + 1}`).join('\n')
    const server = await stub(() => ({
      status: 200,
      body: { variants: [{ variant: 'leadership', sourceDraft: longDraft }, { variant: 'personal', sourceDraft: '' }] },
    }))

    const result = await runWrp(['reports', 'preview', '--start', '2026-02-09', '--end', '2026-02-15'], {
      stub: server,
      env: { TZ: 'Asia/Shanghai' },
    })

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/reports/preview')
    expect(requestBody(server.requests[0])).toEqual({
      weekStart: '2026-02-09T00:00:00+08:00',
      weekEnd: '2026-02-15T00:00:00+08:00',
    })

    expect(result.stdout).toContain('── leadership ── 15 line(s),')
    expect(result.stdout).toContain('- event 12')
    expect(result.stdout).not.toContain('- event 13')
    expect(result.stdout).toContain('... 3 more line(s) — rerun with --full')
    expect(result.stdout).toContain('── personal ── 0 line(s), 0 chars (EMPTY)')
  })

  it('prints everything under --full', async () => {
    const longDraft = Array.from({ length: 15 }, (_, index) => `- event ${index + 1}`).join('\n')
    const server = await stub(() => ({ status: 200, body: { variants: [{ variant: 'leadership', sourceDraft: longDraft }] } }))

    const result = await runWrp(
      ['reports', 'preview', '--start', '2026-02-09', '--end', '2026-02-15', '--full'],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- event 15')
    expect(result.stdout).not.toContain('more line(s)')
  })

  it('filters to one variant and requires both dates', async () => {
    const server = await stub(() => ({ status: 200, body: { variants: REPORT_DETAIL.variants } }))

    const filtered = await runWrp(
      ['reports', 'preview', '--start', '2026-02-09', '--end', '2026-02-15', '--variant', 'personal'],
      { stub: server },
    )
    expect(filtered.code).toBe(0)
    expect(filtered.stdout).toContain('── personal ──')
    expect(filtered.stdout).not.toContain('── leadership ──')

    const missing = await runWrp(['reports', 'preview', '--start', '2026-02-09'], { stub: server })
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('✗ missing period end (--end)')
  })
})

describe('wrp reports create', () => {
  /** Search is the advisory duplicate check; POST /api/reports is the create. */
  function createResponder({ existing = [] } = {}) {
    return (request) => {
      if (request.url.startsWith('/api/reports/search')) return { status: 200, body: { reports: existing } }
      return {
        status: 201,
        body: {
          report: { id: 31, title: '第 8 周周报', weekStart: '2026-02-16', weekEnd: '2026-02-22' },
          variants: [
            { variant: 'leadership', sourceDraft: '- Nexus 上线' },
            { variant: 'personal', sourceDraft: '- No events this week' },
          ],
          snapshots: [{ id: 1 }, { id: 2 }],
        },
      }
    }
  }

  it('creates the report, then flags an empty draft loudly', async () => {
    const server = await stub(createResponder())

    const result = await runWrp(
      ['reports', 'create', '--title', '第 8 周周报', '--start', '2026-02-16', '--end', '2026-02-22'],
      { stub: server, env: { TZ: 'Asia/Shanghai' } },
    )

    expect(result.code).toBe(0)
    const created = server.requests.find((request) => request.method === 'POST')
    expect(created.url).toBe('/api/reports')
    expect(requestBody(created)).toEqual({
      title: '第 8 周周报',
      weekStart: '2026-02-16T00:00:00+08:00',
      weekEnd: '2026-02-22T00:00:00+08:00',
    })

    const lines = result.stdout.split('\n')
    // Law 1: the feedback line comes first, in the exact contract shape.
    expect(lines[0]).toBe('✓ report created: #31 — 第 8 周周报 (2026-02-16 ~ 2026-02-22)')
    expect(result.stdout).toContain('snapshots: 2 event(s)')
    expect(result.stdout).toContain('leadership: source draft 10 chars')
    expect(result.stdout).toContain('personal: source draft 21 chars — EMPTY')
    expect(result.stdout).toContain('⚠ empty source draft: personal')
    expect(result.stdout).not.toContain('already cover this week')
  })

  it('nudges when a report already covers the week, without blocking', async () => {
    const server = await stub(createResponder({ existing: [{ id: 7, title: '旧的第 8 周' }] }))

    const result = await runWrp(
      ['reports', 'create', '--title', '第 8 周周报', '--start', '2026-02-16', '--end', '2026-02-22'],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('⚠ 1 report(s) already cover this week: #7')
    expect(server.requests.some((request) => request.method === 'POST' && request.url === '/api/reports')).toBe(true)
  })

  it('requires a title', async () => {
    const server = await stub()

    const result = await runWrp(['reports', 'create', '--start', '2026-02-16', '--end', '2026-02-22'], {
      stub: server,
    })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ missing report title (--title)')
    expect(server.requests).toHaveLength(0)
  })
})

describe('wrp reports regenerate-source', () => {
  it('names the variants whose adopted final became stale', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        id: 31,
        variants: [
          { variant: 'leadership', sourceDraft: '- a', sourceRevision: 5, finalStatus: 'stale' },
          { variant: 'personal', sourceDraft: '- b', sourceRevision: 5, finalStatus: 'none' },
        ],
        snapshots: [{ id: 1 }, { id: 2 }, { id: 3 }],
      },
    }))

    const result = await runWrp(['reports', 'regenerate-source', '31'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/reports/31/regenerate-source')
    expect(result.stdout.split('\n')[0]).toBe('✓ report source regenerated: #31')
    expect(result.stdout).toContain('snapshots: 3 event(s)')
    expect(result.stdout).toContain('leadership: rev 5, 3 chars, final stale')
    expect(result.stdout).toContain('personal: rev 5, 3 chars, final none')
    expect(result.stdout).toContain('⚠ marked stale: leadership')
    expect(result.stdout).not.toContain('marked stale: leadership, personal')
  })
})

describe('wrp reports save-final', () => {
  it('saves from --file and records template/style provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wrp-final-'))
    const file = join(dir, 'final.md')
    await writeFile(file, '# 第 8 周\n\n交付 Nexus。\n')
    const server = await stub(() => ({ status: 200, body: { finalStatus: 'current' } }))

    const result = await runWrp(
      [
        'reports', 'save-final', '31',
        '--variant', 'leadership',
        '--file', file,
        '--source-revision', '5',
        '--template-id', '12',
        '--ai-style-key', 'concise',
      ],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(server.requests[0].method).toBe('PUT')
    expect(server.requests[0].url).toBe('/api/reports/31/final')
    expect(requestBody(server.requests[0])).toEqual({
      variant: 'leadership',
      content: '# 第 8 周\n\n交付 Nexus。\n',
      sourceRevision: 5,
      templateId: '12',
      aiStyleKey: 'concise',
    })
    expect(result.stdout.trim()).toBe('✓ final saved: #31 (leadership) — 18 chars, status current')
  })

  it('turns revision drift into one loud ✗ line carrying the API 409 code', async () => {
    const server = await stub(() => ({
      status: 409,
      body: {
        code: 'SOURCE_REVISION_CONFLICT',
        error: 'The source draft has changed. Regenerate the final version from the latest draft.',
      },
    }))

    const result = await runWrp(
      ['reports', 'save-final', '31', '--variant', 'leadership', '--content', '# stale final', '--source-revision', '4'],
      { stub: server },
    )

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ SOURCE_REVISION_CONFLICT: The source draft has changed.')
    expect(result.stderr).toContain('→ re-read with wrp reports show 31 --part meta')
    expect(result.stdout).toBe('')
  })

  it('requires exactly one of --content/--file and an integer revision', async () => {
    const server = await stub()

    const neither = await runWrp(['reports', 'save-final', '31', '--variant', 'leadership'], { stub: server })
    expect(neither.code).not.toBe(0)
    expect(neither.stderr).toContain('✗ provide exactly one of --content or --file')

    const badRevision = await runWrp(
      ['reports', 'save-final', '31', '--variant', 'leadership', '--content', 'x', '--source-revision', 'abc'],
      { stub: server },
    )
    expect(badRevision.code).not.toBe(0)
    expect(badRevision.stderr).toContain('✗ --source-revision must be an integer')

    const badVariant = await runWrp(
      ['reports', 'save-final', '31', '--variant', 'boss', '--content', 'x'],
      { stub: server },
    )
    expect(badVariant.code).not.toBe(0)
    expect(badVariant.stderr).toContain('✗ --variant must be leadership or personal')
    expect(server.requests).toHaveLength(0)
  })
})

describe('wrp reports delete', () => {
  const deletable = {
    id: 31,
    title: '第 8 周周报',
    weekStart: '2026-02-16',
    weekEnd: '2026-02-22',
    variants: [
      { variant: 'leadership', finalContent: '# final', sourceDraft: '- a' },
      { variant: 'personal', finalContent: null, sourceDraft: '- b' },
    ],
    snapshots: [{ id: 1 }, { id: 2 }],
  }

  it('previews the loss and refuses without --confirm (law 4)', async () => {
    const server = await stub(() => ({ status: 200, body: deletable }))

    const result = await runWrp(['reports', 'delete', '31'], { stub: server })

    expect(result.code).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(result.stdout).toContain('PLAN:')
    expect(result.stdout).toContain('delete #31 — 第 8 周周报 (2026-02-16 ~ 2026-02-22)')
    expect(result.stdout).toContain('2 variant(s), 2 snapshot event(s)')
    expect(result.stdout).toContain('adopted final(s) lost permanently: leadership')
    expect(result.stdout).toContain('NOT EXECUTED — re-run with --confirm')
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(false)
  })

  it('surfaces the accepted-proposal audit guard instead of working around it', async () => {
    const server = await stub((request) => {
      if (request.method === 'DELETE') {
        return {
          status: 409,
          body: {
            code: 'AUDIT_RECORD_REQUIRED',
            error:
              'This report contains generation audit records for an accepted final version. Keep the report or archive its sessions first.',
          },
        }
      }
      return { status: 200, body: deletable }
    })

    const result = await runWrp(['reports', 'delete', '31', '--confirm'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ AUDIT_RECORD_REQUIRED: This report contains generation audit records')
    expect(result.stderr).toContain('→ keep this report')
    expect(result.stdout).not.toContain('✓')
  })

  it('deletes with --confirm and prints the feedback line', async () => {
    const server = await stub((request) =>
      request.method === 'DELETE' ? { status: 200, body: { success: true } } : { status: 200, body: deletable },
    )

    const result = await runWrp(['reports', 'delete', '31', '--confirm'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ report deleted: #31')
    expect(server.requests.some((request) => request.method === 'DELETE' && request.url === '/api/reports/31')).toBe(true)
  })
})
