// Behaviour tests for the plans module (#125).
//
// Seam: the real wrp CLI as a subprocess against a stub HTTP server, so the
// assertions are exactly what an agent gets - the request the client sends,
// the text it prints, and the exit code.
//
// The comment block below is the ported successor of the pre-merge plan-comment
// suite (kept untouched until the cutover ticket #130): same cases, new command
// shape and output laws.

import { describe, it, expect, afterEach } from 'vitest'
import { runWrp, startStubServer, errorLines } from './wrp-cli-harness.mjs'

const stubs = []

async function stub(respond) {
  const server = await startStubServer(respond)
  stubs.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

function chainComment(overrides) {
  return {
    id: 7,
    planItemId: 9,
    content: 'Original blocker',
    author: 'weekly-reporter/claude-code',
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

describe('wrp plans comments list', () => {
  it('lists the chain with id/item/time/author/period/content and a footer', async () => {
    const server = await stub(() => ({
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
    }))

    const result = await runWrp(['plans', 'comments', 'list', '12'], {
      stub: server,
      env: { WEEKLY_REPORTER_PAT: 'wrp_test_token', TZ: 'UTC' },
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      '#7 [%9] [2026-10-13T09:00:00+00:00] [weekly-reporter/claude-code] [Week 2026-10-12 - 2026-10-18] Original blocker',
    )
    expect(result.stdout).toContain(
      '#8 [%12] [2026-10-20T09:00:00+00:00] [user] [Week 2026-10-19 - 2026-10-25] Successor follow-up',
    )
    expect(result.stdout).toContain('— 2 comment(s)')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(server.requests[0].url).toBe('/api/plan-items/12/comments')
    expect(server.requests[0].headers.authorization).toBe('Bearer wrp_test_token')
    expect(server.requests[0].headers['x-weekly-reporter-agent']).toMatch(/^weekly-reporter\//)
  })

  it('renders comment times in the system zone, without the old UTC suffix', async () => {
    const server = await stub(() => ({
      status: 200,
      body: { commentCount: 1, comments: [chainComment()] },
    }))

    const result = await runWrp(['plans', 'comments', 'list', '12'], {
      stub: server,
      env: { TZ: 'Asia/Shanghai' },
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      '#7 [%9] [2026-10-13T17:00:00+08:00] [weekly-reporter/claude-code] [Week 2026-10-12 - 2026-10-18] Original blocker',
    )
    expect(result.stdout).not.toContain(' UTC]')
  })

  it('prints an explicit empty state', async () => {
    const server = await stub(() => ({ status: 200, body: { commentCount: 0, comments: [] } }))

    const result = await runWrp(['plans', 'comments', 'list', '12'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('No comments on plan item %12.')
  })

  it('reports a missing plan item as a ✗ line and exits non-zero', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Plan item not found' } }))

    const result = await runWrp(['plans', 'comments', 'list', '999'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Plan item not found')
    expect(result.stderr).toContain('→')
  })

  it('rejects a missing item id before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'comments', 'list'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('item id')
    expect(server.requests).toHaveLength(0)
  })
})

describe('wrp plans comments add', () => {
  it('posts the content and reports the comment id and authorship', async () => {
    const server = await stub(() => ({
      status: 201,
      body: chainComment({ id: 21, planItemId: 12, content: 'blocked by @17', author: null }),
    }))

    const result = await runWrp(
      ['plans', 'comments', 'add', '12', '--text', 'blocked by @17'],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ comment created: #21 on %12 (author: user)')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/plan-items/12/comments')
    expect(JSON.parse(server.requests[0].body)).toEqual({ content: 'blocked by @17' })
  })

  it('reports the API-stamped author when present', async () => {
    const server = await stub(() => ({
      status: 201,
      body: chainComment({ id: 21, planItemId: 12, author: 'weekly-reporter/claude-code' }),
    }))

    const result = await runWrp(['plans', 'comments', 'add', '12', '--text', 'note'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('(author: weekly-reporter/claude-code)')
  })

  it('rejects missing content before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'comments', 'add', '12'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('--text')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects blank content before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'comments', 'add', '12', '--text', '   '], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('--text')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces the 404 for a missing plan item', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Plan item not found' } }))

    const result = await runWrp(['plans', 'comments', 'add', '999', '--text', 'note'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Plan item not found')
  })
})

describe('wrp plans comments delete', () => {
  it('deletes through the owning plan item and reports the pair', async () => {
    const server = await stub(() => ({ status: 200, body: { deleted: true } }))

    const result = await runWrp(['plans', 'comments', 'delete', '12', '7'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ comment deleted: #7 on %12')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('DELETE')
    expect(server.requests[0].url).toBe('/api/plan-items/12/comments/7')
  })

  it('reports a comment that is not pinned to the item', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Comment not found' } }))

    const result = await runWrp(['plans', 'comments', 'delete', '12', '7'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Comment not found')
  })

  it('rejects a missing comment id before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'comments', 'delete', '12'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('comment id')
    expect(server.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Plan items
// ---------------------------------------------------------------------------

function planItem(overrides) {
  return {
    id: 5,
    periodPlanId: 3,
    text: 'Ship it',
    status: 'planned',
    priority: 'normal',
    isImportant: false,
    isUrgent: false,
    projectScope: 'work',
    parentItemId: null,
    deferredFromItemId: null,
    position: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  }
}

const WEEK_PLAN = { id: 3, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', monthKey: null }

describe('wrp plans list', () => {
  it('prints the plan header and items with every marker, even when false', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        plan: WEEK_PLAN,
        items: [
          planItem({ id: 5, text: 'High and flagged', priority: 'high', isImportant: true }),
          planItem({ id: 6, text: 'Normal unflagged', priority: 'normal' }),
          planItem({ id: 7, text: 'Deferred follow-up', priority: 'low', parentItemId: 9, deferredFromItemId: 2 }),
        ],
      },
    }))

    const result = await runWrp(['plans', 'list', '--scope', 'week', '--date', '2026-10-15'], {
      stub: server,
    })

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(server.requests[0].url).toBe('/api/plans?scope=week&date=2026-10-15')

    expect(result.stdout).toContain('plan 3 [week] [2026-10-12 → 2026-10-18]')
    // Order is the API's (priority group, then position); the client prints it.
    expect(result.stdout).toContain(
      '%5 [planned] [work] [priority=high] [important=true] [urgent=false] High and flagged',
    )
    expect(result.stdout).toContain(
      '%6 [planned] [work] [priority=normal] [important=false] [urgent=false] Normal unflagged',
    )
    expect(result.stdout).toContain(
      '%7 [planned] [work] [priority=low] [important=false] [urgent=false] [parent=%9] [deferred-from=%2] Deferred follow-up',
    )
    expect(result.stdout.indexOf('%5')).toBeLessThan(result.stdout.indexOf('%6'))
    expect(result.stdout.indexOf('%6')).toBeLessThan(result.stdout.indexOf('%7'))
    expect(result.stdout).toContain('— 3 item(s)')
  })

  it('sends the week pair when week-start and week-end are given', async () => {
    const server = await stub(() => ({ status: 200, body: { plan: WEEK_PLAN, items: [] } }))

    const result = await runWrp(
      ['plans', 'list', '--scope', 'week', '--week-start', '2026-10-12', '--week-end', '2026-10-18'],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toBe('/api/plans?scope=week&weekStart=2026-10-12&weekEnd=2026-10-18')
    expect(result.stdout).toContain('No items in this plan.')
  })

  it('sends the month key or a date for month scope', async () => {
    const server = await stub(() => ({ status: 200, body: { plan: WEEK_PLAN, items: [] } }))

    await runWrp(['plans', 'list', '--scope', 'month', '--month', '2026-10'], { stub: server })
    await runWrp(['plans', 'list', '--scope', 'month', '--date', '2026-10-15'], { stub: server })

    expect(server.requests[0].url).toBe('/api/plans?scope=month&month=2026-10')
    expect(server.requests[1].url).toBe('/api/plans?scope=month&date=2026-10-15')
  })

  it('prints an explicit empty state when no plan exists', async () => {
    const server = await stub(() => ({ status: 200, body: { plan: null, items: [] } }))

    const result = await runWrp(['plans', 'list', '--scope', 'week', '--date', '2026-10-15'], {
      stub: server,
    })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('No plan found for this period.')
  })

  it('rejects missing or incomplete period flags before calling the API', async () => {
    const server = await stub()

    const noScope = await runWrp(['plans', 'list', '--date', '2026-10-15'], { stub: server })
    const noPeriod = await runWrp(['plans', 'list', '--scope', 'week'], { stub: server })
    const badScope = await runWrp(['plans', 'list', '--scope', 'day', '--date', '2026-10-15'], {
      stub: server,
    })

    expect(noScope.code).not.toBe(0)
    expect(noScope.stderr).toContain('scope')
    expect(noPeriod.code).not.toBe(0)
    expect(noPeriod.stderr).toContain('--date')
    expect(badScope.code).not.toBe(0)
    expect(badScope.stderr).toContain("'week' or 'month'")
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces an API 400 as one ✗ line', async () => {
    const server = await stub(() => ({ status: 400, body: { error: 'Invalid date format. Use YYYY-MM-DD' } }))

    const result = await runWrp(['plans', 'list', '--scope', 'week', '--date', '2026-13-01'], {
      stub: server,
    })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Invalid date format. Use YYYY-MM-DD')
  })
})

describe('wrp plans add', () => {
  it('posts the item (letting the API auto-create the plan) and reports both ids', async () => {
    const server = await stub(() => ({
      status: 201,
      body: planItem({ id: 42, periodPlanId: 7, text: 'Write the report', priority: 'high', isImportant: true, isUrgent: true }),
    }))

    const result = await runWrp(
      [
        'plans', 'add', '--scope', 'week',
        '--week-start', '2026-10-12', '--week-end', '2026-10-18',
        '--text', 'Write the report',
        '--project', 'personal',
        '--priority', 'high',
        '--important', 'true',
        '--urgent', 'true',
      ],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ plan item created: %42 (plan 7)')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/plan-items')
    expect(JSON.parse(server.requests[0].body)).toEqual({
      scope: 'week',
      text: 'Write the report',
      projectScope: 'personal',
      weekStart: '2026-10-12',
      weekEnd: '2026-10-18',
      priority: 'high',
      isImportant: true,
      isUrgent: true,
    })
  })

  it('defaults project scope to work and posts a month item', async () => {
    const server = await stub(() => ({ status: 201, body: planItem({ id: 43, periodPlanId: 8 }) }))

    await runWrp(['plans', 'add', '--scope', 'month', '--month', '2026-10', '--text', 'Monthly goal'], {
      stub: server,
    })

    expect(JSON.parse(server.requests[0].body)).toEqual({
      scope: 'month',
      text: 'Monthly goal',
      projectScope: 'work',
      month: '2026-10',
    })
  })

  it('traces a parent item id onto the payload', async () => {
    const server = await stub(() => ({ status: 201, body: planItem() }))

    await runWrp(
      ['plans', 'add', '--scope', 'week', '--week-start', '2026-10-12', '--week-end', '2026-10-18', '--text', 'x', '--parent', '9'],
      { stub: server },
    )

    expect(JSON.parse(server.requests[0].body).parentItemId).toBe(9)
  })

  it('validates priority and markers client-side, before the API', async () => {
    const server = await stub()

    const priority = await runWrp(
      ['plans', 'add', '--scope', 'month', '--month', '2026-10', '--text', 'x', '--priority', 'urgent'],
      { stub: server },
    )
    const important = await runWrp(
      ['plans', 'add', '--scope', 'month', '--month', '2026-10', '--text', 'x', '--important', 'yes'],
      { stub: server },
    )
    const urgent = await runWrp(
      ['plans', 'add', '--scope', 'month', '--month', '2026-10', '--text', 'x', '--urgent', '1'],
      { stub: server },
    )
    // An empty --project must fail client-side instead of silently defaulting.
    const emptyProject = await runWrp(
      ['plans', 'add', '--scope', 'month', '--month', '2026-10', '--text', 'x', '--project', ''],
      { stub: server },
    )
    // A whitespace-only --text must fail client-side instead of creating a blank item.
    const blankText = await runWrp(
      ['plans', 'add', '--scope', 'month', '--month', '2026-10', '--text', '   '],
      { stub: server },
    )

    expect(priority.code).not.toBe(0)
    expect(priority.stderr).toContain('high, normal, low')
    expect(important.code).not.toBe(0)
    expect(important.stderr).toContain("'true' or 'false'")
    expect(urgent.code).not.toBe(0)
    expect(urgent.stderr).toContain("'true' or 'false'")
    expect(emptyProject.code).not.toBe(0)
    expect(emptyProject.stderr).toContain('✗ invalid --project')
    expect(blankText.code).not.toBe(0)
    expect(blankText.stderr).toContain('✗ missing item text (--text)')
    expect(server.requests).toHaveLength(0)
  })

  it('requires the period flags and text before calling the API', async () => {
    const server = await stub()

    const noText = await runWrp(['plans', 'add', '--scope', 'month', '--month', '2026-10'], { stub: server })
    const noWeekEnd = await runWrp(
      ['plans', 'add', '--scope', 'week', '--week-start', '2026-10-12', '--text', 'x'],
      { stub: server },
    )
    const noMonth = await runWrp(['plans', 'add', '--scope', 'month', '--text', 'x'], { stub: server })

    expect(noText.code).not.toBe(0)
    expect(noText.stderr).toContain('--text')
    expect(noWeekEnd.code).not.toBe(0)
    expect(noWeekEnd.stderr).toContain('--week-end')
    expect(noMonth.code).not.toBe(0)
    expect(noMonth.stderr).toContain('--month')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces a parent-containment 400 with the API detail', async () => {
    const server = await stub(() => ({
      status: 400,
      body: { error: "Parent item's month does not contain the week start date" },
    }))

    const result = await runWrp(
      ['plans', 'add', '--scope', 'week', '--week-start', '2026-10-12', '--week-end', '2026-10-18', '--text', 'x', '--parent', '9'],
      { stub: server },
    )

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain("Parent item's month does not contain the week start date")
    expect(result.stderr).toContain('→')
  })
})

describe('wrp plans update', () => {
  it('treats false as a real update', async () => {
    const server = await stub(() => ({ status: 200, body: planItem({ isImportant: false, isUrgent: false }) }))

    const result = await runWrp(
      ['plans', 'update', '12', '--important', 'false', '--urgent', 'false'],
      { stub: server },
    )

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ plan item updated: %12')
    expect(server.requests[0].method).toBe('PUT')
    expect(server.requests[0].url).toBe('/api/plan-items/12')
    expect(JSON.parse(server.requests[0].body)).toEqual({ isImportant: false, isUrgent: false })
  })

  it('clears the parent link with an empty --parent', async () => {
    const server = await stub(() => ({ status: 200, body: planItem({ parentItemId: null }) }))

    await runWrp(['plans', 'update', '12', '--parent', ''], { stub: server })

    expect(JSON.parse(server.requests[0].body)).toEqual({ parentItemId: null })
  })

  it('sends every field that was passed', async () => {
    const server = await stub(() => ({ status: 200, body: planItem() }))

    await runWrp(
      [
        'plans', 'update', '12',
        '--text', '  Revised text  ',
        '--status', 'in_progress',
        '--project', 'personal',
        '--position', '4',
        '--parent', '9',
        '--priority', 'low',
        '--important', 'true',
        '--urgent', 'false',
      ],
      { stub: server },
    )

    expect(JSON.parse(server.requests[0].body)).toEqual({
      text: 'Revised text',
      status: 'in_progress',
      projectScope: 'personal',
      position: 4,
      parentItemId: 9,
      priority: 'low',
      isImportant: true,
      isUrgent: false,
    })
  })

  it('refuses an empty update before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'update', '12'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('at least one')
    expect(server.requests).toHaveLength(0)
  })

  it('validates status and priority client-side', async () => {
    const server = await stub()

    const status = await runWrp(['plans', 'update', '12', '--status', 'blocked'], { stub: server })
    const priority = await runWrp(['plans', 'update', '12', '--priority', 'urgent'], { stub: server })

    expect(status.code).not.toBe(0)
    expect(status.stderr).toContain('planned, in_progress, done, cancelled, deferred')
    expect(priority.code).not.toBe(0)
    expect(priority.stderr).toContain('high, normal, low')
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces a 400 from the API and a 404', async () => {
    const server = await stub((request) =>
      request.url === '/api/plan-items/12' && request.method === 'PUT'
        ? { status: 400, body: { error: 'Invalid parent item' } }
        : { status: 404, body: { error: 'Plan item not found' } },
    )

    const invalid = await runWrp(['plans', 'update', '12', '--parent', '9'], { stub: server })
    const missing = await runWrp(['plans', 'update', '999', '--text', 'x'], { stub: server })

    expect(invalid.code).not.toBe(0)
    expect(invalid.stderr).toContain('Invalid parent item')
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('Plan item not found')
  })

  it('rejects a non-numeric item id before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'update', 'abc', '--text', 'x'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('item id')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a trailing-garbage id (no parseInt truncation) before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'update', '12abc', '--text', 'x'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('invalid item id')
    expect(server.requests).toHaveLength(0)
  })

  it('accepts the %id token printed by wrp plans list', async () => {
    const server = await stub(() => ({ status: 200, body: planItem({ id: 42 }) }))

    const result = await runWrp(['plans', 'update', '%42', '--text', 'x'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toBe('/api/plan-items/42')
  })
})

describe('wrp plans defer', () => {
  it('creates the successor and reports both ids', async () => {
    const server = await stub(() => ({
      status: 201,
      body: planItem({ id: 43, periodPlanId: 4, deferredFromItemId: 42 }),
    }))

    const result = await runWrp(['plans', 'defer', '42'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ plan item deferred: %43 (from %42)')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/plan-items/42/defer')
  })

  it('surfaces the 400 for an item that is already done', async () => {
    const server = await stub(() => ({
      status: 400,
      body: { error: 'Only planned or in_progress items can be deferred' },
    }))

    const result = await runWrp(['plans', 'defer', '42'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Only planned or in_progress items can be deferred')
  })

  it('surfaces a 404 for a missing item', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Plan item not found' } }))

    const result = await runWrp(['plans', 'defer', '999'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Plan item not found')
  })

  it('rejects a missing item id before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'defer'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('item id')
    expect(server.requests).toHaveLength(0)
  })
})

describe('wrp plans delete', () => {
  it('hard-deletes and prints feedback (the Go server answers 200)', async () => {
    const server = await stub(() => ({ status: 200, body: { deleted: true } }))

    const result = await runWrp(['plans', 'delete', '42'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ plan item deleted: %42')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('DELETE')
    expect(server.requests[0].url).toBe('/api/plan-items/42')
  })

  it('also accepts the legacy 204 answer', async () => {
    const server = await stub(() => ({ status: 204 }))

    const result = await runWrp(['plans', 'delete', '42'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('✓ plan item deleted: %42')
  })

  it('surfaces a 404 for a missing item', async () => {
    const server = await stub(() => ({ status: 404, body: { error: 'Plan item not found' } }))

    const result = await runWrp(['plans', 'delete', '999'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Plan item not found')
  })

  it('rejects a missing item id before calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['plans', 'delete'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('item id')
    expect(server.requests).toHaveLength(0)
  })
})
