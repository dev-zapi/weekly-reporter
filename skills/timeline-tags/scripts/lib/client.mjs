// Shared HTTP + arg helpers for the timeline-tags skill scripts.

export const BASE_URL = process.env.WEEKLY_REPORTER_URL || 'http://localhost:6868'

// Mirror of the server's TAG_CHARSET_REGEX (src/lib/tags/parse.ts): Han
// characters, Latin letters, digits — and never digits-only (a tag must
// contain at least one Han character or letter). Catching a bad name here
// keeps it from becoming a 400 on an operation that rewrites event content.
export const TAG_CHARSET_REGEX =
  /^(?=[\p{Script=Han}A-Za-z0-9]*[\p{Script=Han}A-Za-z])[\p{Script=Han}A-Za-z0-9]+$/u

export const TAG_CHARSET_MESSAGE =
  'Tag name may contain only Chinese characters, letters, and digits (digits-only is rejected)'

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
    // HTML error pages have no JSON body; body stays null.
  }
  return { status: response.status, body }
}

/** Turn a non-2xx response into a readable message and exit. */
export function failResponse(status, body) {
  const detail = body?.error || body?.message
  const code = body?.code ? ` [${body.code}]` : ''
  if (status >= 400 && status < 500) fail(`Error: ${detail || `Invalid request (HTTP ${status})`}${code}`)
  if (status >= 500) {
    fail(`Error: ${detail || `Server error (HTTP ${status})`}${code}`, 'Check the server logs for details.')
  }
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

/** Fetch all tags with counts. Server returns them alphabetically sorted. */
export async function fetchTags() {
  const { status, body } = await api('/api/tags')
  if (status !== 200) failResponse(status, body, 'Tags')
  return body?.tags ?? []
}

/** Validate a tag name against the server's charset rule, or exit with the reason. */
export function validateTag(name, label) {
  if (!name) fail(`Error: ${label} tag name is required`)
  if (!TAG_CHARSET_REGEX.test(name)) {
    fail(`Error: ${label} name '${name}' is invalid. ${TAG_CHARSET_MESSAGE}`)
  }
  return name
}
