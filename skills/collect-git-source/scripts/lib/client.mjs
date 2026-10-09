// Shared HTTP + resolution helpers for the collect-git-source skill scripts.
// Copied from report-templates' client.mjs — same shape, same env var, same
// exit-code contract. Zero deps, built-in fetch (Node 18+).

export const BASE_URL = process.env.WEEKLY_REPORTER_URL || 'http://localhost:6868'

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

export function jsonPatch(payload) {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
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
