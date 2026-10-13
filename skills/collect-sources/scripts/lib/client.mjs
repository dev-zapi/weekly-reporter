// Shared HTTP + resolution helpers for the collect-sources skill scripts.
// Merged from report-templates' and collect-git-source's client.mjs — same
// env var, same exit-code contract. Zero deps, built-in fetch (Node 18+).

export const BASE_URL = process.env.WEEKLY_REPORTER_URL || 'http://localhost:6868'

export const TYPES = ['git-local', 'git-remote-github', 'git-remote-gitlab', 'git-remote-gitee']
export const SCOPES = ['work', 'personal']
export const SOURCE_STATUSES = ['enabled', 'disabled', 'unavailable']
export const SYNC_STATUSES = ['success', 'failure', 'never']

/** Print to stderr and exit non-zero. Scripts should never throw raw stack traces. */
export function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/**
 * Call the weekly-reporter API and return `{ status, body }`.
 * A connection failure is terminal — the fix is always the same
 * (start the server) and no caller can do anything smarter about it.
 */
export async function api(path, init) {
  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, init)
  } catch {
    fail(
      `Error: Cannot reach weekly-reporter at ${BASE_URL}`,
      'Is the server running? Try: npm run dev  (or set WEEKLY_REPORTER_URL)',
    )
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    // 204 and HTML error pages have no JSON body; body stays null.
  }
  return { status: response.status, body }
}

export function json(payload) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

export function jsonPut(payload) {
  return { ...json(payload), method: 'PUT' }
}

export function jsonPatch(payload) {
  return { ...json(payload), method: 'PATCH' }
}

/** Turn a non-2xx response into a readable message and exit. */
export function failResponse(status, body, context) {
  const detail = body?.error || body?.message
  const code = body?.code ? ` [${body.code}]` : ''
  if (status === 404) fail(`Error: ${detail || `${context} not found`}${code}`)
  if (status === 409) fail(`Error: ${detail || `${context} is busy`}${code}`)
  if (status >= 400 && status < 500) fail(`Error: ${detail || `Invalid request (HTTP ${status})`}${code}`)
  if (status >= 500) fail(`Error: ${detail || `Server error (HTTP ${status})`}${code}`, 'Check the server logs for details.')
  fail(`Error: Unexpected response (HTTP ${status})`)
}

/**
 * Minimal flag parser. Returns `{ flags, positional }`.
 * `spec` maps `--flag` to `'value'`, `'boolean'`, or `'multi'` (accumulate
 * multiple values of the same flag into an array, for repeated --email).
 * Unknown flags are rejected so a typo surfaces immediately.
 */
export function parseArgs(argv, spec, usage) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const kind = spec[arg]
    if (!kind) fail(`Error: unexpected argument '${arg}'`, usage)
    if (kind === 'boolean') {
      flags[arg.slice(2)] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) fail(`Error: ${arg} requires a value`, usage)
    if (kind === 'multi') {
      (flags[arg.slice(2)] ||= []).push(value)
    } else {
      flags[arg.slice(2)] = value
    }
  }
  return { flags, positional }
}

/** Branch config entries are strings or `{ name, lastCommitTime }` objects. */
export function branchNames(source) {
  const branches = source?.config?.branches
  if (!Array.isArray(branches)) return []
  return branches.map((b) => (typeof b === 'string' ? b : b?.name)).filter(Boolean)
}

/**
 * Fetch every collect source, following the API's pagination. Filters map
 * straight onto the list endpoint's query params (name matches name OR alias
 * server-side, so callers get that for free).
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
    if (status !== 200) failResponse(status, body, 'Collect sources')
    const batch = body?.sources ?? []
    all.push(...batch)
    total = body?.total ?? all.length
    if (batch.length === 0) break // guard against a server that ignores page
    page++
  }
  return all
}

/**
 * Resolve a human-supplied reference to exactly one source: a numeric ID, or
 * a name/alias (exact match first, substring as fallback). Callers usually
 * know the name, not the ID; ambiguous matches fail loudly instead of
 * picking one arbitrarily — two sources may legitimately share a name.
 */
export async function resolveSource(ref, usage) {
  if (!ref) fail('Error: a source reference is required (ID or name)', usage)

  // Every script prints ids as "#12", so callers naturally copy that form —
  // accept it instead of failing on the leading hash.
  const normalizedRef = ref.replace(/^#/, '')
  if (/^\d+$/.test(normalizedRef)) {
    const { status, body } = await api(`/api/collect/sources/${normalizedRef}`)
    if (status === 200) return body?.source ?? body
    if (status === 404) fail(`Error: no collect source with ID ${normalizedRef}`, 'Run list.mjs to see what exists.')
    failResponse(status, body, `Source #${normalizedRef}`)
  }

  const all = await fetchAllSources()
  const needle = normalizedRef.toLowerCase()
  const matches = (predicate) => all.filter(predicate)
  const exact = matches((s) => s.name.toLowerCase() === needle
    || (s.config?.aliases ?? []).some((a) => a.toLowerCase() === needle))
  if (exact.length === 1) return exact[0]

  const substring = matches((s) => s.name.toLowerCase().includes(needle)
    || (s.config?.aliases ?? []).some((a) => a.toLowerCase().includes(needle)))
  if (substring.length === 1) return substring[0]

  const candidates = new Set([...exact, ...substring])
  if (candidates.size > 1) {
    fail(
      `Error: '${ref}' matches ${candidates.size} collect sources:`,
      ...[...candidates].map((s) => `  #${s.id}  ${s.name}`),
      'Pass one of those IDs instead.',
    )
  }
  fail(`Error: no collect source matches '${ref}'`, 'Run list.mjs to see what exists.')
}

export function formatDate(value) {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}
