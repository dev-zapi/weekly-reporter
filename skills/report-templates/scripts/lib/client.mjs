// Shared HTTP + resolution helpers for the report-templates skill scripts.
// Templates live behind two different ID conventions (see resolveRef), so
// centralising resolution here is what keeps every script from re-deriving it.

// >>> AUTH-BLOCK:BEGIN
// Shared auth plumbing for the vendored skill clients: credential resolution,
// self-report headers, and the HTTP call every script goes through.
//
// Each skill ships its own copy (skills install individually and must stay
// self-contained), so this block is stamped into every client by
// scripts/sync-client-auth.mjs. The skill name placeholder is replaced with
// the owning skill's name - to change this block, edit the template in
// scripts/templates/ and re-run the sync script, never a skill's copy.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_PATH = join(homedir(), '.config', 'weekly-reporter', 'auth.json')

let machineConfig

/**
 * Machine-level credentials from ~/.config/weekly-reporter/auth.json.
 * Returns null when the file is missing, unreadable or malformed - a missing
 * credential must never crash a script, it only means the API answers 401.
 */
function readMachineConfig() {
  if (machineConfig !== undefined) return machineConfig
  try {
    machineConfig = existsSync(CONFIG_PATH)
      ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))?.machine ?? null
      : null
  } catch {
    machineConfig = null
  }
  return machineConfig
}

/**
 * Which agent runtime drives this script. zellij is deliberately not mapped:
 * it is a terminal multiplexer, not an agent.
 */
function detectAgentName() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude-code'
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex'
  if (process.env.OPENCODE || process.env.OPENCODE_BIN) return 'opencode'
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  return 'unknown'
}

export const BASE_URL =
  process.env.WEEKLY_REPORTER_BASE_URL
  || process.env.WEEKLY_REPORTER_URL
  || readMachineConfig()?.baseUrl
  || 'http://localhost:6868'

export const PAT =
  process.env.WEEKLY_REPORTER_PAT
  || readMachineConfig()?.pat
  || null

export const AGENT_NAME = detectAgentName()
export const SKILL_NAME = 'report-templates'

/** Print to stderr and exit non-zero. Scripts should never throw raw stack traces. */
export function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/**
 * A 401 always means the credential is missing, wrong or dead. Point the agent
 * at the configure-pat skill instead of leaking a bare status code.
 */
export function failUnauthorized() {
  fail(
    `Error: Unauthorized (HTTP 401) from ${BASE_URL}`,
    'Your Personal Access Token is missing, invalid, expired, or revoked.',
    'Run the configure-pat skill (or: node scripts/configure-pat.mjs) to set one up.',
  )
}

/**
 * Header values must be printable ASCII - a cwd with non-ASCII characters
 * would make fetch throw on an invalid header value.
 */
function headerSafe(value) {
  return value.replace(/[^\x20-\x7e]/g, '?')
}

/**
 * Call the weekly-reporter API and return `{ status, body }`.
 * A connection failure is terminal and reported here, because the fix is always
 * the same (start the server) and no caller can do anything smarter about it.
 * A 401 is terminal too: no caller can fix a dead credential on its own, and
 * the fix (configure-pat) is the same everywhere.
 */
export async function api(path, init) {
  const headers = {
    ...(init?.headers ?? {}),
    ...(PAT ? { Authorization: `Bearer ${PAT}` } : {}),
    'X-Weekly-Reporter-Agent': `${SKILL_NAME}/${AGENT_NAME}`,
    'X-Weekly-Reporter-Cwd': headerSafe(process.cwd()),
  }
  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, headers })
  } catch {
    fail(
      `Error: Cannot reach weekly-reporter at ${BASE_URL}`,
      'Is the server running? Try: npm run dev  (or set WEEKLY_REPORTER_URL)',
    )
  }
  if (response.status === 401) failUnauthorized()
  let body = null
  let bodyParsed = false
  try {
    body = await response.json()
    bodyParsed = true
  } catch {
    // 204 and HTML error pages have no JSON body; body stays null.
  }
  return { status: response.status, body, bodyParsed }
}
// <<< AUTH-BLOCK:END

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

/** Turn a non-2xx response into a readable message and exit. */
export function failResponse(status, body, context) {
  const detail = body?.error || body?.message
  const code = body?.code ? ` [${body.code}]` : ''
  if (status === 404) fail(`Error: ${detail || `${context} not found`}${code}`)
  if (status === 410) fail(`Error: ${detail || 'This endpoint was removed'}${code}`)
  if (status >= 400 && status < 500) fail(`Error: ${detail || `Invalid request (HTTP ${status})`}${code}`)
  if (status >= 500) fail(`Error: ${detail || `Server error (HTTP ${status})`}${code}`, 'Check the server logs for details.')
  fail(`Error: Unexpected response (HTTP ${status})`)
}

/**
 * Minimal flag parser. Returns `{ flags, positional }`.
 * `spec` maps `--flag` to `'value'` or `'boolean'`; unknown flags are rejected
 * so a typo surfaces immediately instead of being silently ignored.
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
    flags[arg.slice(2)] = value
  }
  return { flags, positional }
}

/** Fetch both template collections in one call. */
export async function fetchAll() {
  const { status, body } = await api('/api/templates')
  if (status !== 200) failResponse(status, body, 'Templates')
  return {
    official: (body?.official ?? []).map(normalizeOfficial),
    user: (body?.user ?? []).map(normalizeUser),
  }
}

/** Official templates are code constants: string id, array tags, never editable. */
function normalizeOfficial(row) {
  return {
    kind: 'official',
    selectionId: row.id,
    apiPath: null,
    name: row.name,
    content: row.content ?? '',
    description: row.description ?? null,
    tags: Array.isArray(row.tags) ? row.tags.join(', ') : (row.tags ?? null),
    aiStyle: row.aiStyle ?? 'formal',
    sourceTemplateId: null,
    createdAt: null,
    updatedAt: null,
  }
}

/** User templates are DB rows: numeric id, comma-string tags, full CRUD. */
function normalizeUser(row) {
  return {
    kind: 'user',
    selectionId: `user-${row.id}`,
    apiPath: `/api/templates/${row.id}`,
    numericId: row.id,
    name: row.name,
    content: row.content ?? '',
    description: row.description ?? null,
    tags: row.tags ?? null,
    aiStyle: row.aiStyle ?? 'formal',
    sourceTemplateId: row.sourceTemplateId ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

/**
 * Resolve a human-supplied reference to exactly one template.
 * Accepts a selection ID (`official-general`, `user-3`), a bare numeric user ID
 * (`3`), or a case-insensitive name substring — callers usually know the name,
 * not the ID, and forcing a lookup round-trip on them wastes a step.
 * Ambiguous names fail loudly rather than picking one arbitrarily.
 */
export async function resolveRef(ref, usage) {
  if (!ref) fail('Error: a template reference is required (ID, user-<n>, official-<slug>, or a name)', usage)
  const { official, user } = await fetchAll()
  return resolveIn([...official, ...user], ref)
}

/** Same resolution against an already-fetched list, to avoid a second request. */
export function resolveIn(all, ref) {
  const exact = all.find((t) => t.selectionId === ref)
  if (exact) return exact

  if (/^\d+$/.test(ref)) {
    const byNumber = all.find((t) => t.kind === 'user' && String(t.numericId) === ref)
    if (byNumber) return byNumber
    fail(`Error: no user template with ID ${ref}`, 'Run list.mjs to see what exists.')
  }

  const needle = ref.toLowerCase()
  const byName = all.filter((t) => t.name.toLowerCase().includes(needle))
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    fail(
      `Error: '${ref}' matches ${byName.length} templates:`,
      ...byName.map((t) => `  ${t.selectionId}  ${t.name}`),
      'Pass one of those IDs instead.',
    )
  }
  fail(`Error: no template matches '${ref}'`, 'Run list.mjs to see what exists.')
}

export function requireUserTemplate(template, action) {
  if (template.kind !== 'user') {
    fail(
      `Error: '${template.name}' (${template.selectionId}) is an official template and cannot be ${action}.`,
      `Official templates ship with the app. Clone it first: clone.mjs ${template.selectionId} --name "<new name>"`,
    )
  }
  return template
}

/**
 * Check an aiStyle key against the styles that actually exist.
 * The API only regex-checks the shape, so a typo would be stored happily and
 * then quietly fall back at generation time — catching it here is the point.
 */
export async function requireStyle(key) {
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
    fail(`Error: --style must be lowercase, starting with a letter (got '${key}')`)
  }
  const { status, body } = await api('/api/prompts/styles')
  if (status !== 200) failResponse(status, body, 'AI styles')
  const styles = body?.styles ?? []
  if (!styles.some((style) => style.key === key)) {
    fail(
      `Error: no AI style with key '${key}'`,
      `Available: ${styles.map((style) => `${style.key} (${style.label})`).join(', ') || '(none)'}`,
    )
  }
  return key
}

export function formatDate(value) {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** First line of a body, trimmed for one-line listings. */
export function firstLine(text, max = 44) {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
