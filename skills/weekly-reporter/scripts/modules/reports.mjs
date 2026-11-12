// The reports module (周报): the ported semantics of the pre-merge weekly-report
// verbs, printing under the JSON output laws.
//
// The data model every verb here assumes (see references/reports.md):
//   - a report covers a date range and holds an immutable event snapshot taken
//     at creation; only `regenerate-source` re-reads events,
//   - each report has two audience variants - `leadership` (work scope +
//     manual) and `personal` (everything),
//   - each variant holds a source draft (原稿, deterministic, the source of
//     truth) and a final (终版, `finalStatus` none|current|stale; `stale` means
//     the draft was regenerated after the final was adopted).
//
// The read verbs (`list`, `show`, `preview`) print the API response body
// verbatim as one compact JSON line - law 2. `--variant` narrows the variants
// array and `--part` drops the payload sub-objects (`sourceDraft`/
// `finalContent`) the caller did not ask for; everything else passes through
// untouched. `preview` is a read verb: it computes a snapshot and creates
// nothing, so its drafts are always complete - there is no `--full`.

import { readFile } from 'node:fs/promises'

import { api } from '../lib/api.mjs'
import { requireArg, requireFlag } from '../lib/args.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { emitJson, feedback, preview as previewPlan } from '../lib/output.mjs'
import { naiveInstantWithOffset } from '../lib/time.mjs'

const VARIANTS = ['leadership', 'personal']

// `draft` is the name in the help text; `source` is the name the ported scripts
// used, kept as an alias so both spellings work. `both` (the default) prints the
// whole body; the other parts drop the payload sub-objects the caller did not
// ask for.
const PARTS = { meta: 'meta', source: 'draft', draft: 'draft', final: 'final', both: 'both' }

/** Which payload fields each `--part` removes from a variant (key order kept). */
const PART_OMISSIONS = {
  meta: ['sourceDraft', 'finalContent'],
  draft: ['finalContent'],
  final: ['sourceDraft'],
  both: [],
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const EMPTY_DRAFT_RE = /本周暂无事件|No events this week/

/** The empty-draft literals the API itself treats as empty (source_draft.go). */
function isEmptyDraft(draft) {
  return draft.length === 0 || EMPTY_DRAFT_RE.test(draft)
}

function requireDate(value, flag) {
  if (!value || !DATE_RE.test(value)) {
    fail(`${flag} must be a YYYY-MM-DD date`, `got '${value ?? ''}'`, `pass ${flag} 2026-01-05`)
  }
  return value
}

/**
 * A CLI date (`YYYY-MM-DD`) as the wire instant: system-zone midnight with its
 * offset (`2026-11-03T00:00:00+08:00`). The server folds the calendar day in
 * the request's own offset, so this must stay an offset-bearing wall clock -
 * converting it to a `Z` instant would shift a Shanghai midnight to the day
 * before.
 */
function wireDate(dateString) {
  // `naiveInstantWithOffset` appends the system-zone offset to the wall clock,
  // so midnight stays midnight in the caller's zone (the server folds the
  // calendar day from that same offset).
  const wire = naiveInstantWithOffset(`${dateString}T00:00:00`)
  if (wire == null) {
    fail(`${dateString} is not a calendar date`, '', 'pass a real date such as 2026-01-05')
  }
  return wire
}

/**
 * A report id from a positional argument, or one error envelope. Strict digits:
 * a leading `#` is tolerated for callers holding the old list-line token, but
 * the retired script's `parseInt` tolerated suffixes such as `12abc`; wrp does
 * not.
 */
function requireReportId(raw) {
  const token = String(raw ?? '').replace(/^#/, '')
  if (!/^\d+$/.test(token)) {
    fail('a numeric report id is required', `got '${raw ?? ''}'`, 'find the id with wrp reports list')
  }
  return Number(token)
}

function requireVariant(raw) {
  if (!VARIANTS.includes(raw)) {
    fail(`--variant must be leadership or personal`, `got '${raw ?? ''}'`, 'pass --variant leadership or --variant personal')
  }
  return raw
}

/** A variant with the named fields removed, preserving the remaining key order. */
function withoutFields(variant, fields) {
  return Object.fromEntries(Object.entries(variant).filter(([key]) => !fields.includes(key)))
}

/** The variant as `--part` selects it: payload fields not asked for are dropped. */
function selectPart(variant, part) {
  return withoutFields(variant, PART_OMISSIONS[part])
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * `wrp reports list` — paged, or unpaginated search mode when any of
 * --query/--start/--end is given (newest first either way).
 *
 * The body prints verbatim, so the paging state (`page`/`pageSize`/`total`) and
 * every report field reach the caller without hint lines or a count footer.
 */
export async function list({ flags }) {
  const isSearch = flags.query != null || flags.start != null || flags.end != null

  let path
  if (isSearch) {
    const params = new URLSearchParams()
    if (flags.query) params.set('q', flags.query)
    if (flags.start) params.set('startDate', wireDate(requireDate(flags.start, '--start')))
    if (flags.end) params.set('endDate', wireDate(requireDate(flags.end, '--end')))
    path = `/api/reports/search?${params}`
  } else {
    const params = new URLSearchParams()
    params.set('page', flags.page ?? '1')
    params.set('pageSize', flags.pageSize ?? '10')
    path = `/api/reports?${params}`
  }

  const { status, body } = await api(path)
  if (status !== 200) failResponse(status, body, 'read the report list again')

  // Law 2: one compact JSON line, the API body untouched.
  emitJson(body)
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * `wrp reports show <id>` — the whole body by default. `--variant` narrows the
 * variants array and `--part` drops the payload sub-objects (meta: neither,
 * draft: only `sourceDraft`, final: only `finalContent`), so an agent can skip
 * a thousand-character draft it does not need without the output changing
 * shape. Everything selected prints verbatim.
 */
export async function show({ flags, positional }) {
  const reportId = requireReportId(requireArg(positional, 0, 'report id', 'wrp reports show <id> [--variant] [--part]'))
  const variantFilter = flags.variant ? requireVariant(flags.variant) : null
  const part = PARTS[flags.part ?? 'both']
  if (!part) {
    fail(
      `--part must be one of meta, source, draft, final, both`,
      `got '${flags.part}'`,
      'source is an alias for draft; both (default) prints the whole body, meta drops both payloads',
    )
  }

  const { status, body } = await api(`/api/reports/${reportId}`)
  if (status !== 200) failResponse(status, body, 'find the id with wrp reports list')

  const variants = (body?.variants ?? []).filter(
    (variant) => !variantFilter || variant.variant === variantFilter,
  )
  if (variantFilter && variants.length === 0) {
    fail(`report #${reportId} has no ${variantFilter} variant`, '', 'run wrp reports show <id> without --variant to see both')
  }

  // No filter asked for means the body is already the answer: emit it untouched.
  if (!variantFilter && part === 'both') {
    emitJson(body)
    return
  }
  emitJson({ ...body, variants: variants.map((variant) => selectPart(variant, part)) })
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/**
 * `wrp reports preview` — what a range would capture. Creates nothing, so it is
 * a read verb: the body prints verbatim, drafts complete (the old 12-line head
 * truncation and its `--full` escape hatch are gone).
 */
export async function preview({ flags }) {
  const weekStart = requireDate(
    requireFlag(flags, 'start', 'period start', 'wrp reports preview --start <date> --end <date>'),
    '--start',
  )
  const weekEnd = requireDate(
    requireFlag(flags, 'end', 'period end', 'wrp reports preview --start <date> --end <date>'),
    '--end',
  )
  const variantFilter = flags.variant ? requireVariant(flags.variant) : null

  const { status, body } = await api('/api/reports/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart: wireDate(weekStart), weekEnd: wireDate(weekEnd) }),
  })
  if (status !== 200) failResponse(status, body, 'check --start/--end and retry')

  if (!variantFilter) {
    emitJson(body)
    return
  }
  const variants = (body?.variants ?? []).filter((variant) => variant.variant === variantFilter)
  emitJson({ ...body, variants })
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/** Reports already covering the range, as a "you may be duplicating" nudge. */
async function overlappingReports(wireStart, wireEnd) {
  const params = new URLSearchParams({ startDate: wireStart, endDate: wireEnd })
  const { status, body } = await api(`/api/reports/search?${params}`)
  // The nudge is advisory: a search that fails must not block the create.
  return status === 200 ? (body?.reports ?? []) : []
}

/**
 * `wrp reports create` — snapshots the events in range and builds both source
 * drafts. An empty draft is flagged loudly: it saves fine but cannot produce a
 * final, and the usual cause is a missing sync or the wrong range.
 */
export async function create({ flags }) {
  const title = String(requireFlag(flags, 'title', 'report title', 'wrp reports create --title <text> --start <date> --end <date>')).trim()
  const weekStart = requireDate(
    requireFlag(flags, 'start', 'period start', 'wrp reports create --title <text> --start <date> --end <date>'),
    '--start',
  )
  const weekEnd = requireDate(
    requireFlag(flags, 'end', 'period end', 'wrp reports create --title <text> --start <date> --end <date>'),
    '--end',
  )

  const existing = await overlappingReports(wireDate(weekStart), wireDate(weekEnd))
  const { status, body } = await api('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, weekStart: wireDate(weekStart), weekEnd: wireDate(weekEnd) }),
  })
  if (status !== 201 && status !== 200) failResponse(status, body, 'check --title and that --start is not after --end')

  const report = body?.report ?? body
  feedback('report', 'created', `#${report.id} — ${report.title} (${report.weekStart} ~ ${report.weekEnd})`)
  console.log(`snapshots: ${(body?.snapshots ?? []).length} event(s)`)

  const empty = []
  for (const variant of body?.variants ?? []) {
    const draft = variant.sourceDraft ?? ''
    const flag = isEmptyDraft(draft)
    if (flag) empty.push(variant.variant)
    console.log(`  ${variant.variant}: source draft ${draft.length} chars${flag ? ' — EMPTY' : ''}`)
  }
  if (empty.length > 0) {
    console.log(
      `⚠ empty source draft: ${empty.join(', ')} — saves fine, but no final can be generated from it; check the collect-source sync and the date range, not the report`,
    )
  }
  if (existing.length > 0) {
    const ids = existing.map((item) => `#${item.id}`).join(', ')
    console.log(`⚠ ${existing.length} report(s) already cover this week: ${ids} — duplicates are allowed, delete one if this was accidental`)
  }
}

// ---------------------------------------------------------------------------
// regenerate-source
// ---------------------------------------------------------------------------

/**
 * `wrp reports regenerate-source <id>` — re-reads events, bumps the revision and
 * rebuilds both drafts. An adopted final becomes `stale`: that is the intended
 * signal, so the variants it affected are named.
 */
export async function regenerateSource({ positional }) {
  const reportId = requireReportId(
    requireArg(positional, 0, 'report id', 'wrp reports regenerate-source <id>'),
  )

  const { status, body } = await api(`/api/reports/${reportId}/regenerate-source`, { method: 'POST' })
  if (status !== 200) failResponse(status, body, 'find the id with wrp reports list')

  feedback('report source', 'regenerated', `#${reportId}`)
  console.log(`snapshots: ${(body?.snapshots ?? []).length} event(s)`)

  const stale = []
  for (const variant of body?.variants ?? []) {
    if (variant.finalStatus === 'stale') stale.push(variant.variant)
    console.log(
      `  ${variant.variant}: rev ${variant.sourceRevision}, ${(variant.sourceDraft ?? '').length} chars, final ${variant.finalStatus ?? 'none'}`,
    )
  }
  if (stale.length > 0) {
    console.log(
      `⚠ marked stale: ${stale.join(', ')} — the adopted final no longer matches the draft it was built from; rewrite it before sending the report out`,
    )
  }
}

// ---------------------------------------------------------------------------
// save-final
// ---------------------------------------------------------------------------

/**
 * `wrp reports save-final <id>` — the adopted final for one variant.
 *
 * `--source-revision` turns a concurrent regeneration into a loud 409 instead of
 * overwriting a final built from a newer draft; `--template-id`/`--ai-style-key`
 * snapshot provenance the way the app's own proposal acceptance does.
 */
export async function saveFinal({ flags, positional }) {
  const reportId = requireReportId(
    requireArg(
      positional,
      0,
      'report id',
      'wrp reports save-final <id> --variant <v> (--content <text> | --file <path>)',
    ),
  )
  const variant = requireVariant(requireFlag(flags, 'variant', 'report variant', 'wrp reports save-final <id> --variant leadership'))
  if ((flags.content == null) === (flags.file == null)) {
    fail(
      'provide exactly one of --content or --file',
      flags.content == null ? 'neither was given' : 'both were given',
      'final bodies are multi-line markdown — --file is the reliable path',
    )
  }

  let content = flags.content
  if (flags.file != null) {
    try {
      content = await readFile(flags.file, 'utf8')
    } catch (error) {
      fail('cannot read --file', `${flags.file}: ${error.message}`, 'check the path, then retry')
    }
  }
  if (!content || !content.trim()) {
    fail('final content cannot be empty', '', 'write the final first, then pass it with --file')
  }

  const payload = { variant, content }
  if (flags.sourceRevision != null) {
    const revision = Number.parseInt(flags.sourceRevision, 10)
    if (!Number.isInteger(revision)) {
      fail('--source-revision must be an integer', `got '${flags.sourceRevision}'`, 'read it from wrp reports show <id> --part meta')
    }
    payload.sourceRevision = revision
  }
  if (flags.templateId != null) payload.templateId = flags.templateId
  if (flags.aiStyleKey != null) payload.aiStyleKey = flags.aiStyleKey

  const { status, body } = await api(`/api/reports/${reportId}/final`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (status === 409) {
    failResponse(
      status,
      body,
      `re-read with wrp reports show ${reportId} --part meta (revision field), then rebuild the final from the current draft`,
    )
  }
  if (status !== 200) failResponse(status, body, `re-read with wrp reports show ${reportId} --part meta`)

  feedback(
    'final',
    'saved',
    `#${reportId} (${variant}) — ${content.trim().length} chars, status ${body?.finalStatus ?? 'current'}`,
  )
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

/**
 * `wrp reports delete <id>` — preview first, and never around the accepted-
 * proposal audit guard: a report whose final came from an accepted AI proposal
 * must keep its generation audit trail, so the 409 is surfaced as-is.
 *
 * The DELETE goes straight to the API, exactly as the retired script did: the
 * report is fetched only to render the preview, never on the confirmed path.
 */
export async function remove({ flags, positional }) {
  const reportId = requireReportId(requireArg(positional, 0, 'report id', 'wrp reports delete <id> [--confirm]'))

  if (!flags.confirm) {
    const { status, body } = await api(`/api/reports/${reportId}`)
    if (status !== 200) failResponse(status, body, 'find the id with wrp reports list')

    const variants = body?.variants ?? []
    const snapshots = body?.snapshots ?? []
    const finals = variants.filter((variant) => variant.finalContent).map((variant) => variant.variant)

    previewPlan(
      [
        `delete #${reportId} — ${body.title} (${body.weekStart} ~ ${body.weekEnd})`,
        `${variants.length} variant(s), ${snapshots.length} snapshot event(s), and its generation history`,
        ...(finals.length > 0 ? [`adopted final(s) lost permanently: ${finals.join(', ')}`] : []),
      ],
      ['nothing restores a deleted report — its event snapshot is not rebuildable after the timeline moves on'],
    )
    process.exitCode = 1
    return
  }

  const result = await api(`/api/reports/${reportId}`, { method: 'DELETE' })
  if (result.status === 409) {
    failResponse(
      result.status,
      result.body,
      'keep this report — its accepted-proposal audit trail must survive; archive the sessions in the app instead of deleting the report',
    )
  }
  if (result.status !== 200) failResponse(result.status, result.body, 're-read it with wrp reports show <id>')

  feedback('report', 'deleted', `#${reportId}`)
}
