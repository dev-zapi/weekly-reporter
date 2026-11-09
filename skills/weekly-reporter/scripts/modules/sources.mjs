// The sources module (采集源): the management verbs plus onboarding & sync.
//
// A collect source is a repo the app pulls commits from. The API's PUT replaces
// the whole record, so `update` fetches the current source, resends every field
// it did not change, and never echoes the masked token or the sync cursors back
// (ADR-0011; the server preserves both). `list`/`show`/`create`/`update`/
// `enable`/`delete` are ported verbatim from the pre-merge source-management
// scripts; `lookup`/`emails`/`sync` are ported verbatim from collect-git-source.
// Only the printed lines follow the wrp output contract (format law 3 for
// errors, law 1 for feedback); `lookup`'s exit code 3 is preserved as the clean
// not-found branch signal the onboarding flow switches on.

import { api, json } from '../lib/api.mjs'
import { requireArg, requireFlag } from '../lib/args.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { emptyState, feedback, listFooter, listLine, preview } from '../lib/output.mjs'

/** `sources lookup` found nothing: the flow branches on this without parsing text. */
const LOOKUP_NOT_FOUND_EXIT = 3

export const TYPES = ['git-local', 'git-remote-github', 'git-remote-gitlab', 'git-remote-gitee']
export const SCOPES = ['work', 'personal']
export const SOURCE_STATUSES = ['enabled', 'disabled', 'unavailable']
// `failed` is the Go server's spelling of the same state; accept it as a
// synonym on the `--sync` filter, like the `failure` value it maps to.
export const SYNC_STATUSES = ['success', 'failure', 'failed', 'never']

/** The Go server writes `failed` where the retired TS server wrote `failure`. */
const FAILED_SYNC_STATUSES = new Set(['failure', 'failed'])

function isFailedSyncStatus(status) {
  return FAILED_SYNC_STATUSES.has(status)
}

function usageOf(command) {
  return `wrp sources ${command}`
}

/** `2026-11-07T10:00:00.000Z` → `2026-11-07 10:00:00` (UTC, as before). */
export function formatDate(value) {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** Branch config entries are strings or `{ name, lastCommitTime }` objects. */
export function branchNames(source) {
  const branches = source?.config?.branches
  if (!Array.isArray(branches)) return []
  return branches.map((branch) => (typeof branch === 'string' ? branch : branch?.name)).filter(Boolean)
}

function isMixedEnabledState(source) {
  return source.enabled === false && source.status === 'enabled'
}

/** Empty branch config is meaningful: local = all branches, remote = default branch. */
function branchMode(source) {
  if (branchNames(source).length > 0) return `${branchNames(source).length} branches`
  return source.type === 'git-local' ? 'all-branches' : 'default-branch'
}

/**
 * Fetch every collect source, following the API's pagination. Filters map
 * straight onto the list endpoint's query params (`name` matches the display
 * name OR any alias server-side).
 */
export async function fetchAllSources(filters = {}) {
  const params = new URLSearchParams({ pageSize: '100' })
  if (filters.name) params.set('name', filters.name)
  if (filters.type) params.set('type', filters.type)
  if (filters.sourceStatus) params.set('sourceStatus', filters.sourceStatus)
  if (filters.projectScope) params.set('projectScope', filters.projectScope)
  if (filters.syncStatus) params.set('syncStatus', filters.syncStatus)

  const all = []
  let page = 1
  let total = Infinity
  while (all.length < total) {
    params.set('page', String(page))
    const { status, body } = await api(`/api/collect/sources?${params}`)
    if (status !== 200) failResponse(status, body, 're-run wrp sources list')
    const batch = body?.sources ?? []
    all.push(...batch)
    total = body?.total ?? all.length
    if (batch.length === 0) break // guard against a server that ignores page
    page++
  }
  return all
}

/**
 * Resolve a human-supplied reference to exactly one source: a numeric ID, or a
 * name/alias (exact match first, substring as fallback). Ambiguous matches fail
 * loudly instead of picking one arbitrarily - two sources may share a name.
 */
export async function resolveSource(ref) {
  if (!ref) fail('missing source reference', 'pass an ID, name or alias', 'usage: wrp sources show <ref>')

  // Every list line prints ids as "#12", so accept that form too.
  const normalizedRef = ref.replace(/^#/, '')
  if (/^\d+$/.test(normalizedRef)) {
    const { status, body } = await api(`/api/collect/sources/${normalizedRef}`)
    if (status === 200) return body?.source ?? body
    if (status === 404) fail(`no collect source with ID ${normalizedRef}`, 'nothing has that ID', 'run wrp sources list to see what exists')
    failResponse(status, body, 're-run wrp sources list to check the ID')
  }

  const all = await fetchAllSources()
  const needle = normalizedRef.toLowerCase()
  const exact = all.filter(
    (source) =>
      source.name.toLowerCase() === needle ||
      (source.config?.aliases ?? []).some((alias) => alias.toLowerCase() === needle),
  )
  if (exact.length === 1) return exact[0]

  const substring = all.filter(
    (source) =>
      source.name.toLowerCase().includes(needle) ||
      (source.config?.aliases ?? []).some((alias) => alias.toLowerCase().includes(needle)),
  )
  if (substring.length === 1) return substring[0]

  const candidates = [...new Set([...exact, ...substring])]
  if (candidates.length > 1) {
    const listed = candidates.map((source) => `#${source.id} ${source.name}`).join(', ')
    fail(
      `'${ref}' matches ${candidates.length} collect sources: ${listed}`,
      'the ref is ambiguous',
      'pass one of those IDs instead',
    )
  }
  fail(`no collect source matches '${ref}'`, 'nothing has that name or alias', 'run wrp sources list to see what exists')
}

function validateEnum(flag, value, allowed) {
  if (value !== undefined && !allowed.includes(value)) {
    fail(`invalid --${flag}: '${value}'`, `expected one of: ${allowed.join(', ')}`, `re-run wrp sources list --help`)
  }
}

/** `wrp sources list` — filters, one line per source, count footer. */
export async function list({ flags = {} } = {}) {
  validateEnum('type', flags.type, TYPES)
  validateEnum('status', flags.status, SOURCE_STATUSES)
  validateEnum('scope', flags.scope, SCOPES)
  validateEnum('sync', flags.sync, SYNC_STATUSES)

  const sources = await fetchAllSources({
    name: flags.name,
    type: flags.type,
    sourceStatus: flags.status,
    projectScope: flags.scope,
    syncStatus: flags.sync,
  })

  if (sources.length === 0) {
    emptyState('No collect sources match.')
    return
  }

  for (const source of sources) {
    const aliases = source.config?.aliases ?? []
    const aliasNote = aliases.length ? ` (alias: ${aliases.join(', ')})` : ''
    const emails = source.config?.authorEmails?.length ?? 0
    const sync = source.lastSyncStatus
      ? `sync ${formatDate(source.lastSyncAt)}${isFailedSyncStatus(source.lastSyncStatus) ? ' (failed)' : ''}`
      : 'never synced'
    const metadata = [source.type, source.projectScope, source.status]
    // enabled=false with status=enabled is a stale mixed state (a bare PATCH of
    // enabled does not recompute status); surface it when it occurs.
    if (isMixedEnabledState(source)) metadata.push('enabled=false')
    listLine(
      `#${source.id}`,
      metadata,
      `${source.name}${aliasNote} — ${emails} emails, ${branchMode(source)}, ${sync}`,
    )
  }

  const work = sources.filter((source) => source.projectScope === 'work').length
  // Law 2's footer may carry a caller-supplied detail; the scope breakdown is
  // the deliberate extension here (documented in references/sources.md).
  listFooter(sources.length, 'source', { detail: `(work ${work} / personal ${sources.length - work})` })
}

/** `wrp sources show <ref>` — the only place cursors and full config are shown. */
export async function show({ positional = [] } = {}) {
  const usage = usageOf('show <ref>')
  const source = await resolveSource(requireArg(positional, 0, 'source reference', usage))
  const config = source.config ?? {}

  console.log(`#${source.id} ${source.name}`)
  console.log(
    `  type: ${source.type}   scope: ${source.projectScope}   status: ${source.status}${isMixedEnabledState(source) ? ' (enabled=false)' : ''}`,
  )
  console.log(`  last sync: ${source.lastSyncStatus ? `${formatDate(source.lastSyncAt)} (${source.lastSyncStatus})` : 'never'}`)

  console.log('  config:')
  if (config.owner) console.log(`    owner: ${config.owner}`) // git-local: absolute local path; remote: org/user
  if (config.repo) console.log(`    repo: ${config.repo}`)
  if (config.baseUrl) console.log(`    baseUrl: ${config.baseUrl}`)
  // The server always masks tokens to [ENCRYPTED]; git-local never uses one.
  if (config.token && source.type !== 'git-local') console.log(`    token: ${config.token}`)
  const emails = config.authorEmails ?? []
  console.log(`    authorEmails (${emails.length}): ${emails.join(', ')}`)
  const aliases = config.aliases ?? []
  if (aliases.length) console.log(`    aliases: ${aliases.join(', ')}`)

  const branches = config.branches
  if (Array.isArray(branches) && branches.length) {
    for (const branch of branches) {
      if (typeof branch === 'string') console.log(`    branch ${branch}`)
      else console.log(`    branch ${branch.name} @ cursor ${formatDate(branch.lastCommitTime)}`)
    }
  } else {
    // Empty branch config is meaningful: git-local = collect all local branches,
    // remote = follow the repo's default branch (ADR-0017).
    console.log('    branches: (none configured — all-branches / default branch)')
  }
  for (const cursor of config.branchCursors ?? []) {
    console.log(`    cursor ${cursor.name} @ ${formatDate(cursor.lastCommitTime)}`)
  }

  console.log(`  created: ${formatDate(source.createdAt)}   updated: ${formatDate(source.updatedAt)}`)
}

/**
 * `wrp sources create` — git-local locates the repo by `--path` (stored as
 * `config.owner`); the remote types locate it by owner/repo/token. Client-side
 * checks cover the cheap local rules with clearer messages than the server's
 * zod output; alias collisions, path validity and branch shapes stay with the
 * server, which owns those semantics.
 */
export async function create({ flags = {} } = {}) {
  const type = flags.type ?? 'git-local'
  if (!TYPES.includes(type)) fail(`invalid --type: '${type}'`, `expected one of: ${TYPES.join(', ')}`, 're-run wrp sources create --help')

  const name = flags.name?.trim()
  if (!name) fail('missing --name', 'the source name is required', 'usage: wrp sources create --name <name> ...')
  if (name.length > 100) fail(`invalid --name: ${name.length} characters`, 'a name is at most 100 characters', 'shorten --name and re-run')

  const scope = flags.scope ?? 'personal'
  if (!SCOPES.includes(scope)) fail(`invalid --scope: '${scope}'`, `expected one of: ${SCOPES.join(', ')}`, 're-run wrp sources create --help')

  const emails = flags.email ?? []
  if (emails.length === 0) {
    fail('missing --email', 'at least one author email is required — the API rejects sources without authorEmails', 're-run with --email <address> (repeatable)')
  }
  for (const email of emails) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(`invalid --email: '${email}'`, 'that does not look like an email address', 're-run with a bare address such as a@example.com')
  }

  const aliases = flags.alias ?? []
  if (aliases.length > 20) fail(`invalid --alias: ${aliases.length} values`, 'at most 20 aliases are allowed', 'drop some --alias values and re-run')

  const config = { authorEmails: emails }
  if (type === 'git-local') {
    if (!flags.path) fail('missing --path', 'git-local locates the repo by a directory on this machine', 're-run with --path <repo directory>')
    if (flags.repo || flags.token || flags.baseUrl) {
      fail('--repo / --token / --base-url apply to remote types only', 'git-local locates the repo by --path', 'drop those flags or pass a git-remote-* --type')
    }
    config.owner = flags.path
  } else {
    if (flags.path) fail('--path applies to git-local only', `${type} locates the repo by --owner`, 're-run with --owner <org> --repo <repo> --token <token>')
    const missing = ['owner', 'repo', 'token'].filter((field) => !flags[field])
    if (missing.length) {
      fail(`missing ${missing.map((field) => `--${field}`).join(', ')}`, `all three are required for ${type}`, 're-run with --owner <org> --repo <repo> --token <token>')
    }
    config.owner = flags.owner
    config.repo = flags.repo
    config.token = flags.token
    if (flags.baseUrl) config.baseUrl = flags.baseUrl
  }
  if (flags.branch?.length) config.branches = flags.branch

  const payload = { type, name, projectScope: scope, config }
  if (aliases.length) payload.aliases = aliases

  const { status, body } = await api('/api/collect/sources', json('POST', payload))
  if (status !== 201) failResponse(status, body, 'fix the rejected field and re-run wrp sources create')

  const created = body?.source ?? body
  feedback('source', 'created', `#${created.id} ${created.name} (${created.type}, ${created.projectScope}) — status ${created.status}`)
  if (created.status === 'unavailable') {
    console.log('⚠ marked unavailable right away — that usually means a path the server cannot read')
    console.log(`  check it with: wrp sources show ${created.id}`)
  }
}

/**
 * `wrp sources update <ref>` — the API's PUT replaces the whole record, so every
 * field the caller did not name is backfilled from the stored source. Sync
 * cursors and the stored token are never sent: the server preserves both
 * (ADR-0011), and the token only ever comes back masked as `[ENCRYPTED]`.
 */
export async function update({ flags = {}, positional = [] } = {}) {
  const usage = usageOf('update <ref> [flags]')
  if (flags.email && flags.addEmail) {
    fail('--email and --add-email are exclusive', 'one replaces the list, the other appends', 'pass one of them and re-run')
  }
  if (flags.alias && flags.addAlias) {
    fail('--alias and --add-alias are exclusive', 'one replaces the list, the other appends', 'pass one of them and re-run')
  }
  if (flags.path && flags.owner) {
    fail('--path and --owner are synonyms', 'both name the same field', 'pass one of them and re-run')
  }

  const source = await resolveSource(requireArg(positional, 0, 'source reference', usage))
  const current = source.config ?? {}
  const changed = []

  const name = flags.name != null ? flags.name.trim() : source.name
  if (name.length < 1 || name.length > 100) {
    fail(`invalid --name: ${name.length} characters`, 'a name is 1-100 characters', 'shorten the name and re-run')
  }
  if (flags.name != null) changed.push('name')

  const scope = flags.scope ?? source.projectScope
  if (!SCOPES.includes(scope)) fail(`invalid --scope: '${scope}'`, `expected one of: ${SCOPES.join(', ')}`, 're-run wrp sources update --help')
  if (flags.scope != null) changed.push('scope')

  const config = {}

  // owner: git-local stores the absolute local path, remote stores the org/user.
  const owner = flags.path ?? flags.owner ?? current.owner
  if (owner == null || owner === '') fail('no owner to backfill', 'this source has none stored', 'pass --path (or --owner) and re-run')
  if (flags.path != null || flags.owner != null) changed.push('owner')
  config.owner = owner

  config.repo = flags.repo ?? current.repo
  if (flags.repo != null) changed.push('repo')

  if (flags.baseUrl != null) {
    config.baseUrl = flags.baseUrl
    changed.push('baseUrl')
  } else if (current.baseUrl != null) {
    config.baseUrl = current.baseUrl
  }

  // The stored token arrives masked as [ENCRYPTED], so it must never be echoed
  // into a body: omitting the key makes the server reuse the stored token.
  // Only an explicit --token replaces it.
  if (flags.token != null) {
    config.token = flags.token
    changed.push('token')
  }

  let emails
  if (flags.email) {
    emails = flags.email
    changed.push('emails')
  } else if (flags.addEmail) {
    emails = [...(current.authorEmails ?? [])]
    for (const email of flags.addEmail) {
      if (!emails.some((existing) => existing.toLowerCase() === email.toLowerCase())) emails.push(email)
    }
    changed.push('emails')
  } else {
    emails = current.authorEmails ?? []
  }
  if (emails.length === 0) {
    fail('no author email to send', 'a source needs at least one, and the API rejects an empty authorEmails list', 'pass --email <address> or --add-email <address> and re-run')
  }
  config.authorEmails = emails

  let aliases
  if (flags.alias) {
    aliases = flags.alias
    changed.push('aliases')
  } else if (flags.addAlias) {
    aliases = [...(current.aliases ?? [])]
    for (const alias of flags.addAlias) {
      if (!aliases.includes(alias)) aliases.push(alias)
    }
    changed.push('aliases')
  } else {
    aliases = current.aliases ?? []
  }
  if (aliases.length > 20) fail(`invalid --alias: ${aliases.length} values`, 'at most 20 aliases are allowed', 'drop some and re-run')

  // Branches are replace-only. When the caller names none, resend the current
  // branch NAMES so the server keeps each branch's cursor - and omit the key
  // entirely when there are none, because an empty branch config is the
  // all-branches sentinel (ADR-0017). branchCursors are never sent.
  if (flags.branch) {
    config.branches = flags.branch
    changed.push('branches')
  } else {
    const currentBranches = branchNames(source)
    if (currentBranches.length) config.branches = currentBranches
  }

  const payload = { type: source.type, name, projectScope: scope, config }
  if (aliases.length) payload.aliases = aliases

  if (changed.length === 0) fail('nothing to update', 'pass at least one field', 'usage: wrp sources update <ref> [--name] [--scope] [--email | --add-email] [--alias | --add-alias] [--branch] [--path] [--repo] [--base-url] [--token]')

  const { status, body } = await api(`/api/collect/sources/${source.id}`, json('PUT', payload))
  if (status !== 200) failResponse(status, body, `re-run wrp sources show ${source.id} to check the stored state`)

  const updated = body?.source ?? body
  feedback('source', 'updated', `#${updated.id} ${updated.name} — changed: ${changed.join(', ')}`)
  console.log(`  status: ${updated.status}`)
  // Renaming a branch (rather than adding or removing one) leaves the old
  // name's cursor behind: cursors merge by exact branch name.
  if (flags.branch && branchNames(source).some((previous) => !flags.branch.includes(previous))) {
    console.log('⚠ branches no longer in the list lose their sync cursors; a renamed branch starts from scratch')
  }
}

/**
 * `wrp sources enable <ref> [--off]` — PATCH, not PUT: a full replace for one
 * boolean would risk wiping fields, and PATCHing `enabled` alone leaves `status`
 * stale (the server does not recompute it on PATCH), so both always travel
 * together.
 */
export async function enable({ flags = {}, positional = [] } = {}) {
  const usage = usageOf('enable <ref> [--off]')
  const source = await resolveSource(requireArg(positional, 0, 'source reference', usage))
  const enableIt = !flags.off

  if (enableIt && source.status === 'unavailable') {
    fail(
      `#${source.id} ${source.name} is unavailable`,
      'enabling it now would not fix the cause — that state means no author emails or a broken local path',
      `add emails with wrp sources update ${source.id} --add-email <address>, check the stored path with wrp sources show ${source.id}, then re-run`,
    )
  }

  const { status, body } = await api(
    `/api/collect/sources/${source.id}`,
    json('PATCH', { enabled: enableIt, status: enableIt ? 'enabled' : 'disabled' }),
  )
  if (status !== 200) failResponse(status, body, `re-run wrp sources show ${source.id} to check the stored state`)

  feedback('source', enableIt ? 'enabled' : 'disabled', `#${source.id} ${source.name}`)
}

/**
 * `wrp sources delete <ref> [--confirm]` — nothing restores a deleted source,
 * and name resolution means the caller may not have looked at what they
 * matched, so the match is always shown before --confirm is required.
 */
export async function deleteSource({ flags = {}, positional = [] } = {}) {
  const usage = usageOf('delete <ref> --confirm')
  const source = await resolveSource(requireArg(positional, 0, 'source reference', usage))

  if (!flags.confirm) {
    preview([
      `#${source.id} ${source.name} (${source.type}, ${source.projectScope})`,
      `owner: ${source.config?.owner ?? '—'}`,
      `${source.config?.authorEmails?.length ?? 0} emails, last sync ${source.lastSyncStatus ?? 'never'}`,
      'Events already collected stay on the timeline (they move to the "other" group); the source record and its sync cursors are gone for good.',
    ])
    process.exitCode = 1
    return
  }

  const { status, body } = await api(`/api/collect/sources/${source.id}`, { method: 'DELETE' })
  if (status !== 200) failResponse(status, body, `re-run wrp sources show ${source.id} to check the stored state`)

  feedback('source', 'deleted', `#${source.id} ${source.name}`)
}

/**
 * `wrp sources lookup --path <repo root>` — which git-local source owns a
 * directory. The repo is located by its normalized absolute path only (stored
 * as `config.owner`); the name is display-only, so it can never be the locator.
 *
 * A 404 is the *clean* branch signal: one stderr line and exit 3, so the
 * onboarding flow switches on the exit code instead of parsing error text.
 */
export async function lookup({ flags = {} } = {}) {
  const path = requireFlag(flags, 'path', 'repository path', usageOf('lookup --path <repo-root>')).trim()

  const params = new URLSearchParams({ type: 'git-local', path })
  const { status, body } = await api(`/api/collect/sources/lookup?${params}`)

  if (status === 404) {
    fail(
      `no collect source for path '${path}'`,
      'that directory is not onboarded yet',
      'exit 3 is the clean not-onboarded signal: offer to create the source and sync it',
      { exitCode: LOOKUP_NOT_FOUND_EXIT },
    )
  }
  if (status !== 200) failResponse(status, body, 're-run wrp sources lookup --path <repo-root>')

  const branches = branchNames(body)
  const emails = body?.config?.authorEmails ?? []
  console.log(`id:       ${body.id}`)
  console.log(`name:     ${body.name}`)
  console.log(`status:   ${body.status}`)
  console.log(`enabled:  ${body.enabled}`)
  console.log(`scope:    ${body.projectScope}`)
  console.log(`emails:   ${emails.length ? emails.join(', ') : '—'}`)
  // Empty branch config is meaningful: git-local collects every local branch.
  console.log(`branches: ${branches.length ? branches.join(', ') : 'all branches'}`)
}

/**
 * `wrp sources emails --path <repo root>` — the commit authors the API sees for
 * a directory, in server order (count desc, last 300 commits), so the caller can
 * pick whose commits get collected.
 */
export async function emails({ flags = {} } = {}) {
  const path = requireFlag(flags, 'path', 'repository path', usageOf('emails --path <repo-root>')).trim()

  const params = new URLSearchParams({ type: 'git-local', path })
  const { status, body } = await api(`/api/collect/sources/emails?${params}`)
  if (status !== 200) failResponse(status, body, 'check the path is a readable git repository, then re-run')

  const authors = body?.authors ?? []
  if (authors.length === 0) {
    emptyState('(no commit authors found in the last 300 commits)')
    return
  }

  // Server order is meaningful (count desc); only the columns are padded. The
  // header literal is carried over verbatim from the retired script.
  const countWidth = Math.max(7, String(authors[0].count).length)
  console.log(`${'commits'.padStart(countWidth)}  email                          name`)
  for (const author of authors) {
    console.log(`${String(author.count).padStart(countWidth)}  ${(author.email ?? '').padEnd(30)}  ${author.name ?? ''}`)
  }
}

/**
 * `wrp sources sync <ref> [--enable]` — trigger collection for one source.
 *
 * The source is read first for its name (the summary line names it) and to
 * resolve `<ref>` through the module's usual ID/name/alias rules. `--enable`
 * PATCHes `enabled` and `status` together before syncing (a bare `enabled` flip
 * leaves `status` stale), because a disabled source syncs nothing.
 */
export async function sync({ flags = {}, positional = [] } = {}) {
  if (flags.all) {
    await syncAll({ flags, positional })
    return
  }
  const usage = usageOf('sync <ref> [--enable]')
  const source = await resolveSource(requireArg(positional, 0, 'source reference', usage))
  const sourceName = source.name

  if (flags.enable) {
    const { status, body } = await api(
      `/api/collect/sources/${source.id}`,
      json('PATCH', { enabled: true, status: 'enabled' }),
    )
    if (status !== 200) failResponse(status, body, `re-run wrp sources show ${source.id} to check the stored state`)
  }

  const { status, body } = await api('/api/collect/git-remote/sync', json('POST', { sourceId: source.id }))

  if (status === 409) {
    // The source operation lock: one repo operation (sync or manual fetch) at a
    // time, so a concurrent run is the whole story and retrying is the fix. The
    // API code is the cause and the API message the message slot, so law 3
    // prints exactly one `: ` separator.
    failResponse(status, body, 'another sync or fetch is already running for this repo — retry in a few seconds')
  }

  if (status === 500 && body?.code === 'SYNC_FAILED') {
    const result = body.result ?? {}
    // autoDisabled is set server-side when the source cannot be collected at all
    // (no author emails, unreachable path); name the disable and the fix.
    if (result.autoDisabled) {
      fail(
        `sync failed — #${source.id} ${sourceName} auto-disabled`,
        result.error ?? 'unknown error',
        `the server cannot collect from this source: check the stored path with wrp sources show ${source.id}, or add emails with wrp sources update ${source.id} --path <repo> --add-email <address>, then re-enable it`,
      )
    }
    fail(
      `sync failed for #${source.id} ${sourceName}`,
      result.error ?? 'unknown error',
      `at least one branch did not collect — failed branches: ${describeFailedBranches(result.branches ?? [])}`,
    )
  }

  if (status !== 200) failResponse(status, body, `re-run wrp sources show ${source.id} to check the stored state`)

  const result = body?.result ?? {}
  feedback(
    'source',
    'synced',
    `#${source.id} ${sourceName} — ${result.commitsCount} commits scanned, ${result.eventsCount} new events`,
  )
  for (const line of formatBranches(result.branches ?? [])) console.log(line)
}

/**
 * `wrp sources sync --all` — trigger collection for every enabled source.
 *
 * Same endpoint as the single-source form; an empty body is the server's
 * "every enabled source" switch (sources without author emails are skipped
 * server-side, serially). A failing source does not stop the others: the
 * response carries every per-source result either way, so the whole story
 * prints and only the exit code reflects the failures.
 */
async function syncAll({ flags = {}, positional = [] } = {}) {
  if (positional.length > 0) {
    fail('source reference passed with --all', 'sync --all takes no <ref>; it syncs every enabled source', usageOf('sync --all'))
  }
  if (flags.enable) {
    fail('--enable needs a source reference', 'pass <ref> without --all, or drop --enable', usageOf('sync <ref> [--enable]'))
  }

  const { status, body } = await api('/api/collect/git-remote/sync', json('POST', {}))

  if (status === 409) {
    failResponse(status, body, 'another sync or fetch holds a repo lock — retry in a few seconds')
  }
  if (status !== 200 && body?.code !== 'PARTIAL_SYNC_FAILED') {
    failResponse(status, body, 're-run wrp sources list to check the stored state')
  }

  const results = body?.results ?? []
  if (results.length === 0) {
    emptyState('No enabled sources with author emails to sync.')
    return
  }

  for (const result of results) console.log(formatSyncResult(result))
  const failed = results.filter(isFailedSyncResult)
  if (failed.length > 0) {
    // "every other source still synced" only holds when some did; when the whole
    // batch failed there is nothing else to reassure about.
    const fix =
      failed.length === results.length
        ? 'fix the listed sources (wrp sources show <id>), then re-run'
        : 'every other source still synced; fix the listed sources (wrp sources show <id>), then re-run'
    fail(
      `partial sync failure (${failed.length}/${results.length} sources failed)`,
      failed.map((result) => `#${result.sourceId} ${result.sourceName}`).join(', '),
      fix,
    )
  }

  const commits = results.reduce((sum, result) => sum + (result.commitsCount ?? 0), 0)
  const events = results.reduce((sum, result) => sum + (result.eventsCount ?? 0), 0)
  feedback('sources', 'synced', `${results.length}/${results.length} — ${commits} commits scanned, ${events} new events`)
}

/** `  #7 acme: ✓ 12 commits, 3 new events` / `… ✗ <error> (auto-disabled)`. */
function formatSyncResult(result) {
  const autoDisabled = result.autoDisabled ? ' (auto-disabled)' : ''
  return isFailedSyncResult(result)
    ? `  #${result.sourceId} ${result.sourceName}: ✗ ${result.error || 'failed'}${autoDisabled}`
    : `  #${result.sourceId} ${result.sourceName}: ✓ ${result.commitsCount ?? 0} commits, ${result.eventsCount ?? 0} new events`
}

function isFailedSyncResult(result) {
  return result.status === 'failed' || Boolean(result.error)
}

/** `main: ✓ 3 commits` / `dev: ✗ <error>`, one line per collected branch. */
function formatBranches(branches) {
  return branches.map((branch) =>
    isFailedBranch(branch)
      ? `  ${branch.name}: ✗ ${branch.error || 'failed'}`
      : `  ${branch.name}: ✓ ${branch.commitsCount} commits`,
  )
}

/** `main: <error>; dev: <error>` — the failed-branch list of one ✗ line. */
function describeFailedBranches(branches) {
  const failed = branches.filter(isFailedBranch).map((branch) => `${branch.name}: ${branch.error || 'failed'}`)
  return failed.length > 0 ? failed.join('; ') : 'unknown (no per-branch detail returned)'
}

function isFailedBranch(branch) {
  return branch.status === 'failed' || Boolean(branch.error)
}
