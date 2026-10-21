// Shared HTTP helpers for the write-weekly-report skill scripts.
// Mirrors weekly-reports/scripts/lib/client.mjs so this skill stays
// self-contained (it must work on any agent, with or without siblings
// installed); keep the two files in sync when failure messages change.

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
export const SKILL_NAME = 'write-weekly-report'

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

/** Turn a non-2xx response into a readable message and exit. */
export function failResponse(status, body, context) {
  const detail = body?.error || body?.message
  const code = body?.code ? ` [${body.code}]` : ''
  if (status === 404) fail(`Error: ${detail || `${context} not found`}${code}`)
  if (status === 409) fail(`Error: ${detail || 'Conflict'}${code}`, 'The server state changed. Re-read the report before retrying.')
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
