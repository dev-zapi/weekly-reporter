// The reports module (周报): the ported semantics of the pre-merge weekly-report
// verbs, reformatted to the five format laws.
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
// Multi-line payloads (drafts, finals) are only ever printed by `show`, under an
// explicit `--part` mode - law 5. `preview` prints heads because that is its
// whole purpose, and it creates nothing.

import { readFile } from 'node:fs/promises'

import { api } from '../lib/api.mjs'
import { requireArg, requireFlag } from '../lib/args.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { block, emptyState, feedback, listFooter, listLine, preview as previewPlan } from '../lib/output.mjs'

const VARIANTS = ['leadership', 'personal']

// `draft` is the name in the help text; `source` is the name the ported scripts
// used, kept as an alias so both spellings work.
const PARTS = { meta: 'meta', source: 'draft', draft: 'draft', final: 'final', both: 'both' }

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

function requireReportId(raw) {
  const id = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(id)) {
    fail('a numeric report id is required', `got '${raw ?? ''}'`, 'find the id with wrp reports list')
  }
  return id
}

function requireVariant(raw) {
  if (!VARIANTS.includes(raw)) {
    fail(`--variant must be leadership or personal`, `got '${raw ?? ''}'`, 'pass --variant leadership or --variant personal')
  }
  return raw
}

function formatDate(value) {
  if (value == null) return '?'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** `[leadership:current] [personal:none]` metadata, one entry per variant. */
function variantStatus(variants) {
  return (variants ?? []).map((variant) => `${variant.variant}:${variant.finalStatus ?? 'none'}`)
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * `wrp reports list` — paged, or unpaginated search mode when any of
 * --query/--start/--end is given (newest first either way).
 */
export async function list({ flags }) {
  const isSearch = flags.query != null || flags.start != null || flags.end != null

  let path
  if (isSearch) {
    const params = new URLSearchParams()
    if (flags.query) params.set('q', flags.query)
    if (flags.start) params.set('startDate', requireDate(flags.start, '--start'))
    if (flags.end) params.set('endDate', requireDate(flags.end, '--end'))
    path = `/api/reports/search?${params}`
  } else {
    const params = new URLSearchParams()
    params.set('page', flags.page ?? '1')
    params.set('pageSize', flags.pageSize ?? '10')
    path = `/api/reports?${params}`
  }

  const { status, body } = await api(path)
  if (status !== 200) failResponse(status, body, 'read the report list again')

  const reports = body?.reports ?? []
  if (reports.length === 0) {
    emptyState(
      isSearch
        ? 'No reports matched — widen the date range or change the --query text.'
        : 'No reports yet — wrp reports preview verifies a range before you create one.',
    )
  }
  for (const report of reports) {
    listLine(`#${report.id}`, [`${report.weekStart}~${report.weekEnd}`, ...variantStatus(report.variants)], report.title)
  }
  listFooter(reports.length, 'report')

  if (isSearch) {
    console.log('search mode: unpaginated, newest first')
    return
  }
  const page = Number(body?.page ?? flags.page ?? 1)
  const pageSize = Number(body?.pageSize ?? flags.pageSize ?? 10)
  const total = Number(body?.total ?? reports.length)
  const pages = Math.max(1, Math.ceil(total / (pageSize || 1)))
  console.log(`page ${page}/${pages} of ${total} reports, newest first`)
  if (page < pages) console.log(`next: --page ${page + 1}`)
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * `wrp reports show <id>` — metadata only by default; the drafts and finals are
 * large (a source draft runs to thousands of characters), so they print only
 * under an explicit --part mode, and --variant halves the read.
 */
export async function show({ flags, positional }) {
  const reportId = requireReportId(requireArg(positional, 0, 'report id', 'wrp reports show <id> [--variant] [--part]'))
  const variantFilter = flags.variant ? requireVariant(flags.variant) : null
  const part = PARTS[flags.part ?? 'meta']
  if (!part) {
    fail(
      `--part must be one of meta, source, draft, final, both`,
      `got '${flags.part}'`,
      'source is an alias for draft; meta (default) is enough to decide what to read, and --part draft --variant leadership prints the text',
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

  listLine(`#${body.id}`, [`${body.weekStart}~${body.weekEnd}`], body.title)
  console.log(`updated: ${formatDate(body.updatedAt)}   snapshots: ${(body.snapshots ?? []).length} event(s)`)

  for (const variant of variants) {
    const draft = variant.sourceDraft ?? ''
    const final = variant.finalContent ?? ''
    const status_ = variant.finalStatus ?? 'none'
    console.log(`── ${variant.variant} ──`)
    console.log(
      `final: ${status_}${status_ === 'stale' ? ' (adopted before the latest source draft — regenerate before reuse)' : ''}`,
    )
    console.log(
      `template: ${variant.templateName ?? '—'}   style: ${variant.aiStyle ?? '—'}   sourceRevision: ${variant.sourceRevision}`,
    )
    console.log(`source draft: ${draft.length} chars   final: ${final.length} chars`)

    if (part === 'draft' || part === 'both') block('source draft', draft || '(empty)')
    if (part === 'final' || part === 'both') block('final', final || '(no adopted final)')
  }
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/** `wrp reports preview` — what a range would capture. Creates nothing. */
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
    body: JSON.stringify({ weekStart, weekEnd }),
  })
  if (status !== 200) failResponse(status, body, 'check --start/--end and retry')

  const variants = (body?.variants ?? []).filter(
    (variant) => !variantFilter || variant.variant === variantFilter,
  )
  console.log(`preview ${weekStart} ~ ${weekEnd} — no report is created`)

  for (const variant of variants) {
    const draft = variant.sourceDraft ?? ''
    const lines = draft.split('\n').filter(Boolean)
    console.log(`── ${variant.variant} ── ${lines.length} line(s), ${draft.length} chars${isEmptyDraft(draft) ? ' (EMPTY)' : ''}`)
    if (flags.full) {
      console.log(draft || '(empty)')
    } else {
      // Head-only by default: the usual question is only "does this range hold
      // the right events?", and a full draft can run thousands of characters.
      console.log(lines.slice(0, 12).join('\n') || '(empty)')
      if (lines.length > 12) console.log(`... ${lines.length - 12} more line(s) — rerun with --full`)
    }
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/** Reports already covering the range, as a "you may be duplicating" nudge. */
async function overlappingReports(weekStart, weekEnd) {
  const params = new URLSearchParams({ startDate: weekStart, endDate: weekEnd })
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

  const existing = await overlappingReports(weekStart, weekEnd)
  const { status, body } = await api('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, weekStart, weekEnd }),
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
    process.exit(1)
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
