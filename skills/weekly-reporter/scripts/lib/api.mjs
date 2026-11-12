// HTTP layer for the wrp client: headers, the request every module goes
// through, and the two terminal failures no caller can improve on
// (unreachable server, 401).
//
// A connection failure is reported here because the fix is always the same
// (start the server). A 401 is terminal for the same reason (provision
// credentials), and both point at the exact next command.

import { detectAgentName, resolveCredentials, SKILL_NAME } from './auth.mjs'
import { fail, failUnauthorized } from './errors.mjs'

/**
 * Header values must be printable ASCII: a cwd holding CJK characters would
 * make fetch throw on an invalid header value.
 */
export function headerSafe(value) {
  return value.replace(/[^\x20-\x7e]/g, '?')
}

export function buildHeaders(extra = {}) {
  const { pat } = resolveCredentials()
  return {
    ...extra,
    ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
    'X-Weekly-Reporter-Agent': `${SKILL_NAME}/${detectAgentName()}`,
    'X-Weekly-Reporter-Cwd': headerSafe(process.cwd()),
  }
}

/**
 * Call the weekly-reporter API and return `{ status, body, bodyParsed }`.
 * `bodyParsed` is false for 204 and HTML error pages, which have no JSON body.
 */
export async function api(path, init = {}) {
  const { baseUrl } = resolveCredentials()
  const headers = buildHeaders(init.headers)

  let response
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  } catch {
    fail(
      `Cannot reach weekly-reporter at ${baseUrl}`,
      'is the server running?',
      'start it with npm run dev (or point the client elsewhere with WEEKLY_REPORTER_BASE_URL)',
      { status: null },
    )
  }
  if (response.status === 401) failUnauthorized(baseUrl)

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

/** A JSON request body, for the verbs that write. */
export function json(method, payload) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}
