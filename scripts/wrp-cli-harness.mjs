// CLI-seam harness shared by the wrp test files.
//
// The seam is the CLI: `node skills/weekly-reporter/scripts/wrp.mjs …` runs as a
// real subprocess against an in-test stub HTTP server, so a test observes what
// an agent actually gets - the requests the client sends, the lines it prints,
// and the exit code - without reaching into lib internals.
//
// Module tickets (#121-#129) reuse this file: start a stub, answer the requests
// the module makes, run the real CLI against it, assert on stdout/stderr/exit.

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const WRP_PATH = join(REPO_ROOT, 'skills', 'weekly-reporter', 'scripts', 'wrp.mjs')

// Env vars that would let the host machine's credentials or agent runtime leak
// into a test run: cleared before the test's own values are applied.
const HOST_LEAKS = [
  'WEEKLY_REPORTER_PAT',
  'WEEKLY_REPORTER_BASE_URL',
  'WEEKLY_REPORTER_URL',
  'CLAUDE_CODE',
  'CLAUDECODE',
  'CODEX_HOME',
  'CODEX_SANDBOX',
  'OPENCODE',
  'OPENCODE_BIN',
  'CURSOR_TRACE_ID',
]

/**
 * Stub weekly-reporter API.
 * `respond(request)` returns `{ status, body }` for a JSON answer,
 * `{ status, raw }` for a non-JSON one (204, HTML error page), or nothing for
 * `200 {}`. Every received request is appended to `requests`.
 */
export async function startStubServer(initialRespond) {
  const requests = []
  let respond = initialRespond ?? defaultRespond

  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = { method: req.method, url: req.url, headers: req.headers, body }
    requests.push(request)

    const answer = respond(request) ?? {}
    const status = answer.status ?? 200
    res.writeHead(status, { 'Content-Type': 'application/json', ...(answer.headers ?? {}) })
    if (answer.raw !== undefined) res.end(answer.raw)
    else if (status === 204) res.end()
    else res.end(JSON.stringify(answer.body ?? {}))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    respond(next) {
      respond = next ?? defaultRespond
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function defaultRespond() {
  return { status: 200, body: {} }
}

let sharedEmptyHome

/** A throwaway HOME, so no real machine credential is ever read. */
export async function defaultHome() {
  sharedEmptyHome ??= mkdtemp(join(tmpdir(), 'wrp-home-'))
  return sharedEmptyHome
}

/**
 * A HOME with a `~/.config/weekly-reporter/auth.json` holding `machine`.
 * Pass the result as `home` to `runWrp` to test machine-credential paths.
 */
export async function makeHome({ machine } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wrp-home-'))
  if (!machine) return home
  const dir = join(home, '.config', 'weekly-reporter')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ machine }, null, 2) + '\n', { mode: 0o600 })
  return home
}

/** A port nothing listens on - the deterministic "server is down" address. */
export async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Run the real CLI. `stub` points the client at the stub server;
 * `env` overrides/unsets env vars (`undefined` deletes the key);
 * `input` is fed to stdin (needed for `wrp init`'s password prompt; pass
 * `null` to leave stdin open, e.g. for an interrupt test);
 * `timeoutMs` hard-kills a hung child so a stuck prompt cannot leak processes;
 * `interruptAfterMs` sends SIGINT after that delay (the ctrl-C path).
 */
export async function runWrp(
  args,
  { stub, env = {}, home, input = '', cwd, timeoutMs = 15000, interruptAfterMs } = {},
) {
  const childEnv = await buildEnv({ stub, env, home })
  const child = spawn(process.execPath, [WRP_PATH, ...args], { env: childEnv, cwd })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  // `null` keeps stdin open so the prompt waits for an interrupt/generated input.
  if (input !== null) child.stdin.end(input)

  const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const interruptTimer =
    interruptAfterMs != null ? setTimeout(() => child.kill('SIGINT'), interruptAfterMs) : null

  const code = await new Promise((resolve) => child.on('close', resolve))
  clearTimeout(killTimer)
  if (interruptTimer) clearTimeout(interruptTimer)
  return { code, stdout, stderr }
}

async function buildEnv({ stub, env, home }) {
  const childEnv = { ...process.env }
  for (const key of HOST_LEAKS) delete childEnv[key]
  childEnv.HOME = home ?? (await defaultHome())
  if (stub) childEnv.WEEKLY_REPORTER_BASE_URL = stub.url
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  return childEnv
}
