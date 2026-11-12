// Error envelope for the wrp client - format law 3:
//
//   {"error":{"status":…,"code":…,"message":…,"fix":…}}
//
// Every failure is exactly one compact JSON line on stderr with a non-zero
// exit, so an agent branches on `status`/`code` instead of matching prose.
// `status` is the HTTP status, or null for a client-side fault (bad flags,
// unresolvable refs, an unreachable server). `code` appears only when the API
// or the client supplies one. `message` distills the API error or client cause;
// `fix` carries the actionable next step. Cause/message may be Chinese when they
// come from the API; client-generated text is English.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The command an agent should run in-session (the `!` prefix) to provision
 * machine credentials - printed on every 401. The absolute path is quoted so a
 * skill directory containing spaces still pastes cleanly.
 */
export const INIT_COMMAND = `! node "${join(SCRIPTS_DIR, 'wrp.mjs')}" init`

export const EXIT_FAILURE = 1

/**
 * Print one JSON error envelope to stderr and exit non-zero.
 *
 * `cause` is the headline ("unknown module: x", an API code, …); `message` is
 * the detail. They are distilled into one `message` field so no information the
 * old `✗ cause: message` line carried is lost. `status` is the HTTP status when
 * one exists; `code` is set only by the API or an explicit client signal.
 */
export function fail(cause, message, fix, { exitCode = EXIT_FAILURE, status = null, code } = {}) {
  const distilled = [cause, message]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(': ')
  const error = { status }
  if (code !== undefined && code !== null && code !== '') error.code = code
  error.message = distilled
  if (fix) error.fix = fix
  console.error(JSON.stringify({ error }))
  process.exit(exitCode)
}

/** A 401 always means the credential is missing, wrong or dead. */
export function failUnauthorized(baseUrl) {
  fail(
    `unauthorized (HTTP 401) from ${baseUrl}`,
    'PAT missing, invalid, expired, or revoked',
    `provision machine credentials, then re-run: ${INIT_COMMAND}`,
    { status: 401 },
  )
}

/**
 * Map a non-2xx API response to the envelope. The API's `code` becomes the
 * envelope's `code` verbatim; `message` is its `error`/`message` detail; `fix`
 * is the caller's actionable next step. The HTTP status is carried separately,
 * so the synthesized "request failed (HTTP n)" prose is gone.
 */
export function failResponse(status, body, fix) {
  const message = body?.error || body?.message || 'no detail returned'
  const hint = fix || (status >= 500 ? 'check the server logs for details' : 're-run with corrected input (wrp --help)')
  fail(message, '', hint, { status, code: body?.code })
}

/** The envelope for a command that is registered but not built yet. */
export function failNotImplemented(command, ticket) {
  const planned = ticket ? `scheduled in #${ticket}` : 'scheduled in a later ticket'
  fail(`not implemented: ${command}`, planned, 'run wrp --help for the commands available today')
}
