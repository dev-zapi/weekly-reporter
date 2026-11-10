// The events module (时间线事件) — the timeline's work log.
//
// Ported from the pre-merge timeline scripts with
// the semantics kept verbatim (same filters, payloads, validations and API
// calls) and only the output reformatted to the five format laws of spec #119.
//
// Domain knowledge that the commands rely on (single-line content, #tag/@id/%id
// token boundaries, dangling references, auto-collected events being
// delete-refused) lives in references/events.md.

import { api, json } from '../lib/api.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { emptyState, feedback, listFooter, listLine } from '../lib/output.mjs'
import { detectSystemTimeZone, formatInstant, localDateToOffsetInstant, naiveInstantWithOffset, parseStrictInstant } from '../lib/time.mjs'

const USAGE = {
  list:
    'wrp events list [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD>] [--week-end <YYYY-MM-DD>] ' +
    '[--tags <tag1,tag2>] [--source <manual|auto>] [--limit <n>] [--cursor <id>@<millis>]',
  create: 'wrp events create "<content>" [--time <ISO8601-with-offset>]',
  update: 'wrp events update <id> [--content <text>] [--time <ISO8601-with-offset>] [--important <true|false>]',
  delete: 'wrp events delete <id>',
}

/** `#<id>` list token, or one ✗ line. Strict digits: no parseInt prefix games. */
function parseEventId(value, usage) {
  if (value === undefined || value.trim() === '') {
    fail('missing event id', '', `usage: ${usage}`)
  }
  if (!/^\d+$/.test(value)) {
    fail(
      `invalid event id: ${value}`,
      '',
      'pass the numeric id printed after # by wrp events list',
    )
  }
  return Number(value)
}

/** ISO instant → `2026-11-09T22:02:00+08:00` in the system zone. */
function formatEventTime(value) {
  return formatInstant(value) ?? '?'
}

/**
 * A `--time` the wire can carry: an absolute instant, so `Z` or `±HH:MM` is
 * mandatory. A naive timestamp is refused with the detected zone and a
 * copy-pasteable fix instead of being reinterpreted server-side. A valid input
 * is normalized to UTC, the one shape the client ever sends.
 */
function requireInstant(value, flag) {
  const parsed = parseStrictInstant(value)
  if (parsed.ok) return new Date(parsed.epochMillis).toISOString()

  const timeZone = detectSystemTimeZone()
  if (parsed.reason === 'missing-offset') {
    const localExample = naiveInstantWithOffset(value, timeZone)
    const zuluExample = localExample ? `${localExample.slice(0, 19)}Z` : `${value}Z`
    fail(
      `invalid ${flag}: ${value}`,
      `no UTC offset — the system time zone is ${timeZone}`,
      `add an offset, e.g. ${localExample ?? '2026-11-10T09:00:00+08:00'} or ${zuluExample}`,
    )
  }
  const localExample =
    naiveInstantWithOffset('2026-11-10T09:00:00', timeZone) ?? '2026-11-10T09:00:00+00:00'
  fail(
    `invalid ${flag}: ${value}`,
    `not a valid ISO 8601 instant (system time zone: ${timeZone})`,
    `pass e.g. ${localExample} or ${localExample.slice(0, 19)}Z`,
  )
}

/**
 * A `--date`/`--week-start`/`--week-end` the wire can carry. The CLI still
 * accepts `YYYY-MM-DD`; it expands to midnight in the system zone and keeps
 * that offset on the wire, so the server rounds the calendar day by the
 * client's calendar (not UTC and not the server's zone).
 */
function requireLocalDate(value, flag) {
  const instant = localDateToOffsetInstant(value)
  if (instant === null) {
    fail(
      `invalid ${flag}: ${value}`,
      '',
      `pass a calendar date as YYYY-MM-DD, e.g. ${flag} 2026-11-09`,
    )
  }
  return instant
}

/** `wrp events list` — filters first, id-first lines and the count footer after. */
export async function list({ flags }) {
  const params = new URLSearchParams()
  if (flags.date !== undefined) params.set('date', requireLocalDate(flags.date, '--date'))
  if (flags.weekStart !== undefined) params.set('weekStart', requireLocalDate(flags.weekStart, '--week-start'))
  if (flags.weekEnd !== undefined) params.set('weekEnd', requireLocalDate(flags.weekEnd, '--week-end'))
  if (flags.tags !== undefined) params.set('tags', flags.tags)
  if (flags.source !== undefined) params.set('source', flags.source)
  if (flags.limit !== undefined) params.set('limit', flags.limit)
  if (flags.cursor !== undefined) {
    // The cursor is the API's `{id, eventTime}` pair; it is printed as one
    // copy-pasteable token so `--cursor <token>` continues the walk.
    const match = /^(\d+)@(\d+)$/.exec(flags.cursor)
    if (!match) {
      fail(
        `invalid cursor: ${flags.cursor}`,
        '',
        'the cursor looks like <id>@<epoch-millis>, as printed in the next-page hint',
      )
    }
    params.set('cursorId', match[1])
    params.set('cursorTime', match[2])
  }

  const path = params.size > 0 ? `/api/events?${params}` : '/api/events'
  const { status, body, bodyParsed } = await api(path)

  if (!bodyParsed && status === 200) {
    fail(`unexpected response (HTTP ${status})`, 'the API returned no JSON body', 'check the server logs for details')
  }
  if (status !== 200) {
    failResponse(status, body, 'widen the filters (--date, --week-start/--week-end, --tags)')
  }

  const events = body?.events ?? []
  const hasMore = body?.hasMore ?? false
  const nextCursor = body?.nextCursor

  if (events.length === 0) {
    emptyState('No events found — widen the filters (--date, --week-start/--week-end, --tags).')
    return
  }

  for (const event of events) {
    const metadata = [formatEventTime(event.eventTime), event.source || '?']
    const important = event.isImportant ? '★ ' : ''
    // The content is single-line by rule; a stray newline is shown, not split.
    const content = String(event.content ?? '').replace(/\n/g, ' ↵ ')
    const tags = (event.metadata?.tags ?? []).map((tag) => `#${tag}`).join(' ')
    listLine(`#${event.id}`, metadata, `${important}${content}${tags ? ` ${tags}` : ''}`)
  }

  // events paginates with `--cursor`, so that is the flag the hint advertises.
  listFooter(events.length, 'event', {
    hint:
      hasMore && nextCursor
        ? `next page: --cursor ${nextCursor.id}@${nextCursor.eventTime}`
        : undefined,
  })
}

/** `wrp events create` — one manual entry; `#tag`/`@id`/`%id` parse server-side. */
export async function create({ positional, flags }) {
  const content = positional[0]
  if (content === undefined || content.trim() === '') {
    fail('missing content', 'pass the event text as one positional argument', `usage: ${USAGE.create}`)
  }

  // Verbatim port: only eventTime is conditional; content is the source of truth.
  const eventTime = flags.time === undefined ? undefined : requireInstant(flags.time, '--time')
  const payload = eventTime === undefined ? { content } : { content, eventTime }
  const { status, body } = await api('/api/events', json('POST', payload))

  if (status === 200 || status === 201) {
    const id = body?.id
    feedback('event', 'created', id ? `#${id}` : '(no id returned)')
    return
  }

  failResponse(status, body, 'content must be single-line plain text; check #tag/@id/%id tokens')
}

/** `wrp events update` — at least one of the three fields, `false` included. */
export async function update({ positional, flags }) {
  const id = parseEventId(positional[0], USAGE.update)
  const payload = {}

  if (flags.content !== undefined) {
    if (flags.content === '') fail('missing value for --content', '', `usage: ${USAGE.update}`)
    payload.content = flags.content
  }
  // An empty --time is a truncated shell variable, not a timestamp; sending it
  // would only earn the API's 400 after a pointless round-trip.
  if (flags.time !== undefined) {
    if (flags.time.trim() === '') fail('missing value for --time', '', `usage: ${USAGE.update}`)
    payload.eventTime = requireInstant(flags.time, '--time')
  }
  if (flags.important !== undefined) {
    if (flags.important !== 'true' && flags.important !== 'false') {
      fail(`invalid --important: ${flags.important}`, '', 'pass --important true|false')
    }
    payload.isImportant = flags.important === 'true'
  }

  if (Object.keys(payload).length === 0) {
    fail(
      'missing change (--content | --time | --important)',
      '',
      'pass at least one field to change',
    )
  }

  const { status, body } = await api(`/api/events/${id}`, json('PUT', payload))

  if (status === 200) {
    feedback('event', 'updated', `#${id}`)
    return
  }
  if (status === 404) {
    fail('event not found (HTTP 404)', body?.error || 'no event with that id', 'check the id against wrp events list')
  }
  failResponse(status, body, 're-run wrp events list and retry with a valid id or content')
}

/** `wrp events delete` — manual events only; auto-collected ones are refused (403). */
export async function deleteEvent({ positional }) {
  const id = parseEventId(positional[0], USAGE.delete)
  const { status, body } = await api(`/api/events/${id}`, { method: 'DELETE' })

  if (status === 204) {
    feedback('event', 'deleted', `#${id}`)
    return
  }
  if (status === 403) {
    fail(
      'delete refused (HTTP 403)',
      body?.error || 'the event is not manual',
      'auto-collected events mirror git history — fix the commit or the collect source instead',
    )
  }
  if (status === 404) {
    fail('event not found (HTTP 404)', body?.error || 'no event with that id', 'check the id against wrp events list')
  }
  failResponse(status, body, 're-run wrp events list and retry with a valid id')
}
