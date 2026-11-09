// The plans module (周期计划 / 计划条目 / 计划项评论).
//
// Ported from the pre-merge plans scripts. The semantics — flags, API
// calls, payload shapes, client-side validation, ordering and chain
// aggregation — are kept verbatim; only the output lines follow the wrp
// format laws. Domain rules live in references/plans.md.
//
// Entity grammar: plan items are `%<id>` (the same token timeline events use
// for `%id` citations), comments are `#<id>` here (not timeline tags — the
// context makes the token unambiguous).

import { api, json } from '../lib/api.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { emptyState, feedback, listFooter, listLine } from '../lib/output.mjs'

// ---------------------------------------------------------------------------
// Shared validation (ported from the pre-merge plans client).
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

const STATUSES = ['planned', 'in_progress', 'done', 'cancelled', 'deferred']
const PRIORITIES = ['high', 'normal', 'low']
const PROJECT_SCOPES = ['work', 'personal']

function usage(text) {
  return `usage: ${text}`
}

/** A numeric id from a positional argument, or one ✗ line. */
function requireId(raw, label, usageText) {
  const id = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(id)) {
    fail(`invalid ${label} id`, `expected a numeric ${label} id, got '${raw ?? ''}'`, usage(usageText))
  }
  return id
}

function requireScope(value) {
  if (value !== 'week' && value !== 'month') {
    fail('invalid scope', `--scope must be 'week' or 'month', got '${value ?? ''}'`, usage('wrp plans list --scope <week|month> ...'))
  }
  return value
}

function requireDate(value, flag) {
  if (!value || !DATE_RE.test(value)) {
    fail(`invalid ${flag}`, `expected a YYYY-MM-DD date, got '${value ?? ''}'`)
  }
  return value
}

function requireMonth(value) {
  if (!value || !MONTH_RE.test(value)) {
    fail('invalid --month', `expected a YYYY-MM value, got '${value ?? ''}'`)
  }
  return value
}

function requireProjectScope(value) {
  if (!PROJECT_SCOPES.includes(value)) {
    fail('invalid --project', `must be one of: ${PROJECT_SCOPES.join(', ')}, got '${value ?? ''}'`)
  }
  return value
}

function requireStatus(value) {
  if (!STATUSES.includes(value)) {
    fail('invalid --status', `must be one of: ${STATUSES.join(', ')}, got '${value ?? ''}'`)
  }
  return value
}

function requirePriority(value) {
  if (!PRIORITIES.includes(value)) {
    fail('invalid --priority', `must be one of: ${PRIORITIES.join(', ')}, got '${value ?? ''}'`)
  }
  return value
}

/**
 * An explicit `true`/`false` flag value. The important/urgent markers are
 * booleans, and an explicit `false` must reach the API to clear one - a bare
 * presence flag cannot express that.
 */
function requireBoolean(value, flag) {
  if (value === 'true') return true
  if (value === 'false') return false
  fail(`invalid ${flag}`, `must be 'true' or 'false', got '${value ?? ''}'`)
}

/** A numeric flag value (ids and positions), or one ✗ line. */
function requireInteger(value, flag) {
  const number = Number.parseInt(value, 10)
  if (!Number.isInteger(number)) {
    fail(`invalid ${flag}`, `expected an integer, got '${value ?? ''}'`)
  }
  return number
}

// ---------------------------------------------------------------------------
// Comment formatting (ported from the pre-merge plans comments module).
// ---------------------------------------------------------------------------

/** Browser comments carry no author; the UI (and this client) render them as the user. */
function authorLabel(author) {
  return author ?? 'user'
}

/** ISO timestamp → `YYYY-MM-DD HH:mm UTC`; unparseable values pass through. */
function formatCommentTime(createdAt) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return String(createdAt ?? '')
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// ---------------------------------------------------------------------------
// Plan items
// ---------------------------------------------------------------------------

const LIST_USAGE =
  'wrp plans list --scope <week|month> [--date <YYYY-MM-DD>] [--week-start --week-end] [--month <YYYY-MM>]'
const ADD_USAGE =
  'wrp plans add --scope <week|month> (--week-start --week-end | --month) --text <text> [flags]'
const UPDATE_USAGE = 'wrp plans update <id> [--text] [--status] [--project] [--position] [--parent] [--priority] [--important] [--urgent]'
const DEFER_USAGE = 'wrp plans defer <id>'
const DELETE_USAGE = 'wrp plans delete <id>'

/**
 * A required period flag pair. The API derives the plan from the period, so an
 * ambiguous period is refused here rather than guessed at.
 */
function requirePeriod(flags, scope) {
  if (scope === 'week') {
    if (!flags.weekStart) {
      fail('missing --week-start', 'week scope needs both --week-start and --week-end', usage(ADD_USAGE))
    }
    if (!flags.weekEnd) {
      fail('missing --week-end', 'week scope needs both --week-start and --week-end', usage(ADD_USAGE))
    }
    return {
      weekStart: requireDate(flags.weekStart, '--week-start'),
      weekEnd: requireDate(flags.weekEnd, '--week-end'),
    }
  }
  if (!flags.month) {
    fail('missing --month', 'month scope needs a YYYY-MM key', usage(ADD_USAGE))
  }
  return { month: requireMonth(flags.month) }
}

/** `wrp plans list --scope week|month …` — the plan header plus its items. */
export async function list({ flags }) {
  if (flags.scope === undefined || String(flags.scope).trim() === '') {
    fail('missing --scope', 'every plan query names a period scope', usage(LIST_USAGE))
  }
  const scope = requireScope(flags.scope)

  const params = new URLSearchParams({ scope })
  if (scope === 'week') {
    if (flags.date) {
      params.set('date', requireDate(flags.date, '--date'))
    } else if (flags.weekStart && flags.weekEnd) {
      params.set('weekStart', requireDate(flags.weekStart, '--week-start'))
      params.set('weekEnd', requireDate(flags.weekEnd, '--week-end'))
    } else {
      fail('missing week period', 'for week scope pass --date, or both --week-start and --week-end', usage(LIST_USAGE))
    }
  } else if (flags.date) {
    params.set('date', requireDate(flags.date, '--date'))
  } else if (flags.month) {
    params.set('month', requireMonth(flags.month))
  } else {
    fail('missing month period', 'for month scope pass --date or --month', usage(LIST_USAGE))
  }

  const { status, body } = await api(`/api/plans?${params}`)
  if (status !== 200) failResponse(status, body, 'check the period flags, then re-run')

  const plan = body?.plan
  const items = body?.items ?? []
  if (!plan) {
    emptyState('No plan found for this period.')
    return
  }

  // The header is itself a list line: the plan id is the identity an agent
  // needs to address the plan, and the period is its metadata.
  listLine(`plan ${plan.id}`, [plan.scope, `${plan.periodStart} → ${plan.periodEnd}`])

  if (items.length === 0) {
    emptyState('No items in this plan.')
    return
  }
  for (const item of items) {
    listLine(`%${item.id}`, itemMetadata(item), item.text)
  }
  listFooter(items.length, 'item')
}

/**
 * The item's bracketed metadata. Every marker is printed even when false, so
 * the quadrant position is always readable; the API already ordered the rows
 * by priority group and manual position.
 */
function itemMetadata(item) {
  return [
    item.status,
    item.projectScope,
    `priority=${item.priority}`,
    `important=${item.isImportant}`,
    `urgent=${item.isUrgent}`,
    item.parentItemId ? `parent=%${item.parentItemId}` : null,
    item.deferredFromItemId ? `deferred-from=%${item.deferredFromItemId}` : null,
  ]
}

/** `wrp plans add …` — the API creates the period plan when it does not exist yet. */
export async function add({ flags }) {
  if (flags.scope === undefined || String(flags.scope).trim() === '') {
    fail('missing --scope', 'name the scope of the plan item', usage(ADD_USAGE))
  }
  const scope = requireScope(flags.scope)

  if (flags.text === undefined || String(flags.text).trim() === '') {
    fail('missing item text (--text)', '', usage(ADD_USAGE))
  }

  const payload = {
    scope,
    text: flags.text,
    projectScope: flags.project === undefined ? 'work' : requireProjectScope(flags.project),
    ...requirePeriod(flags, scope),
  }

  if (flags.parent !== undefined) payload.parentItemId = requireInteger(flags.parent, '--parent')
  if (flags.priority !== undefined) payload.priority = requirePriority(flags.priority)
  if (flags.important !== undefined) payload.isImportant = requireBoolean(flags.important, '--important')
  if (flags.urgent !== undefined) payload.isUrgent = requireBoolean(flags.urgent, '--urgent')

  const { status, body } = await api('/api/plan-items', json('POST', payload))
  if (status !== 201) {
    failResponse(status, body, 'check the period and the parent item (a parent month must contain the week)')
  }

  feedback('plan item', 'created', `%${body.id} (plan ${body.periodPlanId})`)
}

/**
 * `wrp plans update <id> …` — omitted fields keep their values, and an
 * explicit `false` is a real update (`--parent ""` clears the link).
 */
export async function update({ flags, positional }) {
  const id = requireId(positional[0], 'item', UPDATE_USAGE)
  const payload = {}

  if (flags.text !== undefined) {
    if (String(flags.text).trim() === '') fail('invalid --text', 'item text cannot be empty')
    payload.text = String(flags.text).trim()
  }
  if (flags.status !== undefined) payload.status = requireStatus(flags.status)
  if (flags.project !== undefined) payload.projectScope = requireProjectScope(flags.project)
  if (flags.position !== undefined) payload.position = requireInteger(flags.position, '--position')
  if (flags.parent !== undefined) {
    payload.parentItemId = flags.parent === '' ? null : requireInteger(flags.parent, '--parent')
  }
  if (flags.priority !== undefined) payload.priority = requirePriority(flags.priority)
  if (flags.important !== undefined) payload.isImportant = requireBoolean(flags.important, '--important')
  if (flags.urgent !== undefined) payload.isUrgent = requireBoolean(flags.urgent, '--urgent')

  if (Object.keys(payload).length === 0) {
    fail('empty update', 'pass at least one of --text, --status, --project, --position, --parent, --priority, --important, --urgent', usage(UPDATE_USAGE))
  }

  const { status, body } = await api(`/api/plan-items/${id}`, json('PUT', payload))
  if (status !== 200) {
    failResponse(status, body, 'check the item id and the parent link, then re-run')
  }

  feedback('plan item', 'updated', `%${id}`)
}

/**
 * `wrp plans defer <id>` — creates the next period's successor (markers
 * inherited, status reset to planned) and marks the original deferred.
 */
export async function defer({ positional }) {
  const id = requireId(positional[0], 'item', DEFER_USAGE)

  const { status, body } = await api(`/api/plan-items/${id}/defer`, json('POST', {}))
  if (status !== 201) {
    failResponse(status, body, 'only planned or in_progress items can be deferred')
  }

  feedback('plan item', 'deferred', `%${body.id} (from %${id})`)
}

/** `wrp plans delete <id>` — a hard delete; children keep their place, unparented. */
export async function remove({ positional }) {
  const id = requireId(positional[0], 'item', DELETE_USAGE)

  const { status, body } = await api(`/api/plan-items/${id}`, { method: 'DELETE' })
  // The Go server answers 200 {deleted:true}; the retired TS route answered 204.
  if (status !== 200 && status !== 204) {
    failResponse(status, body, 'check the item id with wrp plans list, then re-run')
  }

  feedback('plan item', 'deleted', `%${id}`)
}

// ---------------------------------------------------------------------------
// Comments (计划项评论): the only three-level commands.
// ---------------------------------------------------------------------------

const COMMENTS_LIST_USAGE = 'wrp plans comments list <item-id>'
const COMMENTS_ADD_USAGE = 'wrp plans comments add <item-id> --text <text>'
const COMMENTS_DELETE_USAGE = 'wrp plans comments delete <item-id> <comment-id>'

/**
 * `wrp plans comments list <item-id>` — the item's own comments plus its
 * deferral-chain ancestors' comments, oldest-first. The `%<itemId>` on each
 * line is the item the comment is pinned to (that is the pair delete needs),
 * which is not necessarily the item being viewed.
 */
export async function commentsList({ positional }) {
  const itemId = requireId(positional[0], 'item', COMMENTS_LIST_USAGE)
  const { status, body } = await api(`/api/plan-items/${itemId}/comments`)
  if (status !== 200) {
    failResponse(status, body, 'check the item id with wrp plans list, then re-run')
  }

  const comments = body?.comments ?? []
  if (comments.length === 0) {
    emptyState(`No comments on plan item %${itemId}.`)
    return
  }

  for (const comment of comments) {
    listLine(
      `#${comment.id}`,
      [
        `%${comment.planItemId}`,
        formatCommentTime(comment.createdAt),
        authorLabel(comment.author),
        comment.sourcePeriod?.label ?? 'unknown period',
      ],
      comment.content,
    )
  }
  listFooter(comments.length, 'comment')
}

/** `wrp plans comments add <item-id> --text <text>` — append-only, never into the timeline. */
export async function commentsAdd({ flags, positional }) {
  const itemId = requireId(positional[0], 'item', COMMENTS_ADD_USAGE)
  const text = flags.text
  if (text === undefined || String(text).trim() === '') {
    fail('missing comment text (--text)', '', usage(COMMENTS_ADD_USAGE))
  }

  const { status, body } = await api(`/api/plan-items/${itemId}/comments`, json('POST', { content: text }))
  if (status !== 201) {
    failResponse(status, body, 'check the item id with wrp plans list, then re-run')
  }

  feedback('comment', 'created', `#${body.id} on %${itemId} (author: ${authorLabel(body.author)})`)
}

/** `wrp plans comments delete <item-id> <comment-id>` — keyed by the pinned item id. */
export async function commentsDelete({ positional }) {
  const itemId = requireId(positional[0], 'item', COMMENTS_DELETE_USAGE)
  const commentId = requireId(positional[1], 'comment', COMMENTS_DELETE_USAGE)

  const { status, body } = await api(`/api/plan-items/${itemId}/comments/${commentId}`, { method: 'DELETE' })
  if (status !== 200) {
    failResponse(status, body, 'check the #comment and %item pair with wrp plans comments list')
  }

  feedback('comment', 'deleted', `#${commentId} on %${itemId}`)
}
