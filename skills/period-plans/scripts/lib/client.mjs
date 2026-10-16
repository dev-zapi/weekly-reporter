// Shared HTTP helpers for the period-plans skill scripts.
// Self-contained: skills install individually, so this is vendored here
// (not imported from weekly-reports/scripts/lib/client.mjs).

export const BASE_URL = process.env.WEEKLY_REPORTER_URL || 'http://localhost:6868'

/** Print to stderr and exit non-zero. Scripts should never throw raw stack traces. */
export function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/**
 * Call the weekly-reporter API and return `{ status, body }`.
 * A connection failure is terminal and reported here, because the fix is always
 * the same (start the server) and no caller can do anything smarter about it.
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

/** Turn a non-2xx response into a readable message and exit. */
export function failResponse(status, body, context) {
  const detail = body?.error || body?.message
  const code = body?.code ? ` [${body.code}]` : ''
  if (status === 404) fail(`Error: ${detail || `${context} not found`}${code}`)
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

export function requireId(raw, usage) {
  const id = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(id)) fail(`Error: a numeric item ID is required, got '${raw ?? ''}'`, usage)
  return id
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function requireDate(value, flag) {
  if (!value || !DATE_RE.test(value)) fail(`Error: ${flag} must be a YYYY-MM-DD date, got '${value ?? ''}'`)
  return value
}

const MONTH_RE = /^\d{4}-\d{2}$/

export function requireMonth(value) {
  if (!value || !MONTH_RE.test(value)) fail(`Error: --month must be a YYYY-MM value, got '${value ?? ''}'`)
  return value
}

export function requireScope(value) {
  if (value !== 'week' && value !== 'month') fail(`Error: --scope must be 'week' or 'month', got '${value ?? ''}'`)
  return value
}

export function requireProjectScope(value) {
  if (value !== 'work' && value !== 'personal') fail(`Error: --scope must be 'work' or 'personal', got '${value ?? ''}'`)
  return value
}

export function requireStatus(value) {
  const valid = ['planned', 'in_progress', 'done', 'cancelled', 'deferred']
  if (!valid.includes(value)) fail(`Error: --status must be one of: ${valid.join(', ')}, got '${value ?? ''}'`)
  return value
}
