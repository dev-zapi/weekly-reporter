// Error lines for the wrp client - format law 3:
//
//   ✗ <cause|API code>: <message> → <fix>
//
// Every failure is exactly one stderr line with a non-zero exit, so an agent
// can self-recover from the output alone. Cause/message may be Chinese when
// they come from the API; client-generated text is English.

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

/** Print one `✗ …` line to stderr and exit non-zero. */
export function fail(cause, message, fix, { exitCode = EXIT_FAILURE } = {}) {
  const detail = message === undefined || message === '' ? '' : `: ${message}`
  const hint = fix ? ` → ${fix}` : ''
  console.error(`✗ ${cause}${detail}${hint}`)
  process.exit(exitCode)
}

/** A 401 always means the credential is missing, wrong or dead. */
export function failUnauthorized(baseUrl) {
  fail(
    `unauthorized (HTTP 401) from ${baseUrl}`,
    'PAT missing, invalid, expired, or revoked',
    `provision machine credentials, then re-run: ${INIT_COMMAND}`,
  )
}

/**
 * Map a non-2xx API response to the ✗ law. The API's `code`/`error` fields are
 * passed through verbatim; `fix` is the caller's actionable next step.
 */
export function failResponse(status, body, fix) {
  const cause = body?.code || (status >= 500 ? `server error (HTTP ${status})` : `request failed (HTTP ${status})`)
  const message = body?.error || body?.message || 'no detail returned'
  const hint = fix || (status >= 500 ? 'check the server logs for details' : 're-run with corrected input (wrp --help)')
  fail(cause, message, hint)
}

/** The ✗ line for a command that is registered but not built yet. */
export function failNotImplemented(command, ticket) {
  const planned = ticket ? `scheduled in #${ticket}` : 'scheduled in a later ticket'
  fail(`not implemented: ${command}`, planned, 'run wrp --help for the commands available today')
}
