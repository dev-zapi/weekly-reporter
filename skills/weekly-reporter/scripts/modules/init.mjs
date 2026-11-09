// The init module — machine-credential (机器级凭据) provisioning.
//
// Ported from the retired repo-root credential script (deleted in the cutover
// ticket), so this is the one place that WRITES
// `~/.config/weekly-reporter/auth.json`; every other module only reads it
// through lib/auth.mjs. The four modes are mutually exclusive mode switches
// rather than the verb flags the rest of the registry uses:
//
//   wrp init --pat <token> [--base-url <url>]   store a PAT made in the web UI
//   wrp init --base-url <url> [--name <name>]   prompt for the 启动密码, create a PAT
//   wrp init --show                             verify, token masked
//   wrp init --clear                            decommission this machine
//
// Two invariants the old script already had and this keeps: the file is 0600 in
// a 0700 directory (it holds a credential AND possibly the startup password),
// and every write is a read-modify-write of the `machine` member only, so the
// password field and any unknown fields survive.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { DEFAULT_BASE_URL, resolveBaseUrl } from '../lib/auth.mjs'
import { fail } from '../lib/errors.mjs'
import { feedback } from '../lib/output.mjs'

const CONFIG_PATH = join(homedir(), '.config', 'weekly-reporter', 'auth.json')

const USAGE =
  'wrp init [--pat <token> [--base-url <url>] | --base-url <url> [--name <name>] | --show | --clear]'

/** The whole auth file, or null when it is missing, unreadable or malformed. */
export function readConfig(path = CONFIG_PATH) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Write the auth file as 0600 inside a 0700 directory, JSON + trailing newline. */
export function writeConfig(config, path = CONFIG_PATH) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

  const existed = existsSync(path)
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  // A pre-existing file keeps its old mode unless it is chmod'ed explicitly.
  if (existed) {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Some filesystems refuse chmod; the 0600 create mode still applies.
    }
  }
}

/**
 * Merge `machineUpdate` into the `machine` member, preserving every other field.
 * An `undefined` value removes that key, and an emptied `machine` is dropped -
 * that is how `--clear` decommissions without touching the password.
 */
export function updateMachineField(config, machineUpdate) {
  const current = config ?? {}
  const machine = { ...(current.machine ?? {}), ...machineUpdate }
  for (const key of Object.keys(machine)) {
    if (machine[key] === undefined) delete machine[key]
  }
  if (Object.keys(machine).length === 0) {
    const { machine: _dropped, ...rest } = current
    return rest
  }
  return { ...current, machine }
}

/** Show enough of a token to recognise it and too little to use it. */
export function maskPat(pat) {
  if (!pat || typeof pat !== 'string' || pat.length < 10) return '****'
  return `${pat.slice(0, 6)}...${pat.slice(-4)}`
}

/** Octal permission string of a file ('600'), or null when it cannot be read. */
export function getFilePermissions(path) {
  try {
    return (statSync(path).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

function readStartupPassword() {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  // A terminal echoes the typed line (Enter supplies the newline); a pipe does
  // not, so end the prompt line ourselves to keep the next stderr line intact.
  let settled = false
  const settle = (resolve, password) => {
    if (settled) return
    settled = true
    rl.close()
    if (!process.stdin.isTTY) process.stderr.write('\n')
    resolve(password)
  }
  return new Promise((resolve) => {
    // ctrl-C (SIGINT) and ctrl-D / a closed pipe (close) must not hang forever.
    rl.once('SIGINT', () => settle(resolve, ''))
    rl.once('close', () => settle(resolve, ''))
    rl.question('Enter startup password: ', (password) => settle(resolve, password))
  })
}

/** POST /api/auth/pats with the startup password as the Bearer token. */
async function createPatViaApi(baseUrl, name) {
  const password = await readStartupPassword()
  if (!password) fail('missing startup password', '', 're-run wrp init --base-url <url> and paste it')

  let response
  try {
    response = await fetch(`${baseUrl}/api/auth/pats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${password}` },
      body: JSON.stringify({ name }),
    })
  } catch {
    fail(`Cannot reach weekly-reporter at ${baseUrl}`, 'is the server running?', 'start it, then re-run wrp init --base-url <url>')
  }

  let body = null
  try {
    body = await response.json()
  } catch {
    // A non-JSON error page still has a status to report.
  }
  if (!response.ok) {
    fail(
      body?.code || `failed to create PAT (HTTP ${response.status})`,
      body?.error || 'the startup password may be wrong',
      're-run wrp init --base-url <url> with the current startup password',
    )
  }
  if (!body?.token) fail('failed to create PAT', 'the API returned no token', 'create one in the web UI and store it with wrp init --pat <token>')
  return body.token
}

function storeMachine(machineUpdate) {
  writeConfig(updateMachineField(readConfig(), machineUpdate))
}

function patMode(token, baseUrl) {
  storeMachine(baseUrl === undefined ? { pat: token } : { pat: token, baseUrl })
  feedback('machine credential', 'stored', maskPat(token))
  console.log(`  Base URL: ${baseUrl ?? readConfig()?.machine?.baseUrl ?? DEFAULT_BASE_URL}`)
}

async function interactiveMode(baseUrl, name) {
  const token = await createPatViaApi(baseUrl, name ?? `${hostname()}-cli`)
  storeMachine({ baseUrl, pat: token })
  feedback('machine credential', 'created via API', maskPat(token))
  console.log(`  Base URL: ${baseUrl}`)
}

function showMode() {
  const config = readConfig()
  const machine = config?.machine
  if (!machine) {
    console.log('No machine credentials configured.')
    console.log(`Store one with: node ${process.argv[1]} init --pat <token> [--base-url <url>]`)
    return
  }

  const perms = getFilePermissions(CONFIG_PATH)
  console.log('Machine credentials:')
  console.log(`  Base URL: ${machine.baseUrl ?? DEFAULT_BASE_URL}`)
  console.log(`  PAT: ${maskPat(machine.pat)}`)
  if (perms) console.log(`  File permissions: ${perms}`)
  if (perms !== null && perms !== '600') {
    console.log(`⚠ File permissions should be 600, got ${perms} — run: chmod 600 ${CONFIG_PATH}`)
  }
}

function clearMode() {
  if (!readConfig()?.machine) {
    console.log('No machine credentials to clear.')
    return
  }
  storeMachine({ baseUrl: undefined, pat: undefined })
  feedback('machine credentials', 'cleared', CONFIG_PATH.replace(homedir(), '~'))
}

/**
 * `wrp init` — the module is a single command whose flags pick the mode, so the
 * usual "one verb, one action" dispatch does not apply. `--base-url` is a
 * qualifier of `--pat`, and only a mode on its own (that is the interactive
 * path). A bare `wrp init` is interactive too, against the resolved base URL:
 * that is the command the 401 handoff tells the user to run.
 */
export async function run({ flags, positional = [] }) {
  // A bare module is flags-only: the dispatcher already rejects stray verb
  // words, and this guards the same rule for a positional after the flags.
  if (positional.length > 0) {
    fail(`unexpected argument: ${positional[0]}`, '', `usage: ${USAGE}`)
  }

  const { pat, baseUrl, name, show, clear } = flags

  // A truncated shell variable (`--pat "$TOKEN"` with TOKEN unset) must be a
  // usage error, not a config file with an empty credential.
  if (pat === '') fail('missing PAT', '--pat needs a non-empty token', `usage: ${USAGE}`)
  if (baseUrl === '') fail('missing base URL', '--base-url needs a non-empty URL', `usage: ${USAGE}`)
  if (name === '') fail('missing PAT name', '--name needs a non-empty name', `usage: ${USAGE}`)

  // `--pat` + `--base-url` is one mode (store both); every other pairing is a
  // contradiction, and reporting it beats silently picking one.
  const exclusive = [show && '--show', clear && '--clear'].filter(Boolean)
  if (exclusive.length > 1) {
    fail(`conflicting init modes: ${exclusive.join(' ')}`, '', `usage: ${USAGE}`)
  }
  if (exclusive.length === 1 && (pat !== undefined || baseUrl !== undefined || name !== undefined)) {
    fail(
      `conflicting init modes: ${exclusive.join(' ')} with ${pat !== undefined ? '--pat' : baseUrl !== undefined ? '--base-url' : '--name'}`,
      '',
      `usage: ${USAGE}`,
    )
  }
  if (name !== undefined && pat !== undefined) {
    // --name names the PAT created interactively; --pat already has a token.
    fail('--name only applies to interactive init (--base-url)', '', `usage: ${USAGE}`)
  }

  if (pat !== undefined) return patMode(pat, baseUrl)
  if (exclusive.includes('--show')) return showMode()
  if (exclusive.includes('--clear')) return clearMode()
  return interactiveMode(baseUrl ?? resolveBaseUrl(), name)
}
