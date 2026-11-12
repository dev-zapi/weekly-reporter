// Foundation behaviour tests for the wrp client (#120).
//
// Everything here runs against the CLI seam: the real `wrp` entry point as a
// subprocess plus a stub HTTP server. The approved command surface below is
// copied from spec #119 - it is the independent source of truth the generated
// help must match.

import { describe, it, expect, afterEach } from 'vitest'
import { realpath } from 'node:fs/promises'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closedPort,
  makeHome,
  runWrp,
  startStubServer,
  WRP_PATH,
} from './wrp-cli-harness.mjs'

/**
 * Decode the one JSON error envelope a failing run printed on stderr. The CLI
 * may have written prompt text first (wrp init), so parse the last line.
 */
function errorEnvelope(result) {
  const lines = result.stderr.trimEnd().split('\n')
  return JSON.parse(lines.at(-1))
}

// Two-level everywhere; the only three-level command is `plans comments`.
const APPROVED_SURFACE = {
  init: [null],
  sources: ['list', 'show', 'create', 'update', 'enable', 'delete', 'lookup', 'emails', 'sync'],
  events: ['list', 'create', 'update', 'delete'],
  tags: ['list', 'rename', 'remove'],
  plans: ['list', 'add', 'update', 'defer', 'delete', 'comments list', 'comments add', 'comments delete'],
  templates: ['list', 'show', 'create', 'clone', 'update', 'delete'],
  styles: ['list', 'show'],
  reports: ['list', 'show', 'preview', 'create', 'regenerate-source', 'save-final', 'delete'],
}

const stubs = []

async function stub(respond) {
  const server = await startStubServer(respond)
  stubs.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

describe('wrp --help', () => {
  it('enumerates every module and verb of the approved surface', async () => {
    const result = await runWrp(['--help'])

    expect(result.code).toBe(0)
    for (const [module, verbs] of Object.entries(APPROVED_SURFACE)) {
      expect(result.stdout).toContain(`wrp ${module}`)
      for (const verb of verbs) {
        const command = verb ? `wrp ${module} ${verb}` : `wrp ${module}`
        expect(result.stdout, `help should list "${command}"`).toContain(command)
      }
    }
    expect(result.stdout).not.toContain('undefined')
  })

  it('generates per-module help from the same registry', async () => {
    const result = await runWrp(['plans', '--help'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('wrp plans comments add')
    expect(result.stdout).toContain('wrp plans defer')
    expect(result.stdout).not.toContain('wrp sources list')
  })
})

describe('unknown commands', () => {
  it('rejects an unknown module with one JSON error envelope and no request', async () => {
    const server = await stub()
    const result = await runWrp(['frobnicate', 'list'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error).not.toHaveProperty('code')
    expect(error.message).toContain('unknown module')
    expect(error.fix).toContain('wrp --help')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects an unknown verb of a known module', async () => {
    const server = await stub()
    const result = await runWrp(['tags', 'publish'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('unknown verb')
    expect(error.fix).toContain('wrp tags --help')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a partial three-level command', async () => {
    const result = await runWrp(['plans', 'comments'])

    expect(result.code).not.toBe(0)
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('unknown verb')
  })
})

describe('command surface', () => {
  // The old fixture pinned `sources sync` as "registered but not implemented";
  // #128 built it, and every later module ticket builds the rest. Rather than
  // pin whichever verb is still pending, derive the pending set from the CLI's
  // own per-command help: a command that still renders the note must dispatch
  // to exactly one JSON error envelope and never touch the API. Once every
  // module lands, the pending set is empty and this test only has to stay green.
  const commands = Object.entries(APPROVED_SURFACE).flatMap(([module, verbs]) =>
    verbs.map((verb) => (verb ? [module, ...verb.split(' ')] : [module])),
  )

  it('renders per-command help for every approved command, and no sources verb is pending', async () => {
    for (const argv of commands) {
      const result = await runWrp([...argv, '--help'])
      const label = `wrp ${argv.join(' ')}`

      expect(result.code, `${label} --help should exit 0`).toBe(0)
      expect(result.stdout, `${label} --help should describe itself`).toContain(label)
      // #128 built the last sources verbs; the onboarding & sync half included.
      if (argv[0] === 'sources') {
        expect(result.stdout, `${label} is built but help says otherwise`).not.toContain('Not implemented')
      }
    }
  })

  it('dispatches any still-pending command to one envelope without hitting the API', async () => {
    const server = await stub()

    for (const argv of commands) {
      const help = await runWrp([...argv, '--help'])
      if (!help.stdout.includes('Not implemented')) continue

      const label = `wrp ${argv.join(' ')}`
      const result = await runWrp(argv, { stub: server })
      expect(result.code, `${label} is pending but exited 0`).not.toBe(0)
      expect(result.stdout).toBe('')
      const { error } = errorEnvelope(result)
      expect(error.status, `${label} should report a client-side fault`).toBeNull()
      expect(error.message, `${label} should say it is not implemented`).toContain(`not implemented: ${label}`)
    }
    expect(server.requests).toHaveLength(0)
  })

  it('keeps genuinely bad input to one envelope without hitting the API', async () => {
    const server = await stub()
    const result = await runWrp(['sources', 'lookup', '--nope'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('unknown flag: --nope')
    expect(server.requests).toHaveLength(0)
  })
})

describe('positional arity ceiling', () => {
  it('rejects an extra word for a verb that takes no positionals', async () => {
    const server = await stub()

    const result = await runWrp(['events', 'list', 'junk'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('unexpected argument: junk')
    expect(error.fix).toContain('wrp events list takes no positional arguments')
    expect(error.fix).toContain('usage: wrp events list')
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a word past the ceiling for a verb that takes positionals', async () => {
    const server = await stub()

    const result = await runWrp(['sources', 'show', '#7', 'extra'], { stub: server })

    expect(result.code).not.toBe(0)
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error.message).toContain('unexpected argument: extra')
    expect(error.fix).toContain('takes at most 1 positional argument')
    expect(server.requests).toHaveLength(0)
  })

  it('still accepts the documented number of positionals', async () => {
    const server = await stub(() => ({
      status: 200,
      body: { id: 7, name: 'acme', config: { authorEmails: ['a@example.com'] }, type: 'git-local' },
    }))

    const result = await runWrp(['sources', 'show', '#7'], { stub: server })

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].url).toBe('/api/collect/sources/7')
  })
})

describe('unreachable server', () => {
  it('prints the Cannot-reach envelope with the start-server fix hint', async () => {
    const port = await closedPort()
    const baseUrl = `http://127.0.0.1:${port}`
    const result = await runWrp(['tags', 'list'], {
      env: { WEEKLY_REPORTER_BASE_URL: baseUrl, WEEKLY_REPORTER_PAT: 'token' },
    })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBeNull()
    expect(error).not.toHaveProperty('code')
    expect(error.message).toContain(`Cannot reach weekly-reporter at ${baseUrl}`)
    expect(error.fix).toContain('npm run dev')
  })
})

describe('401 handoff', () => {
  it('turns any 401 into the run-wrp-init guidance envelope', async () => {
    const server = await stub(() => ({ status: 401, body: { error: 'Unauthorized' } }))
    const result = await runWrp(['tags', 'list'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    const { error } = errorEnvelope(result)
    expect(error.status).toBe(401)
    expect(error.message).toContain('unauthorized (HTTP 401)')
    expect(error.message).toContain('PAT missing, invalid, expired, or revoked')
    expect(error.fix).toContain(`! node "${WRP_PATH}" init`)
  })
})

describe('API failure envelope', () => {
  it('carries the HTTP status, API code, message and fix on one JSON line', async () => {
    const server = await stub(() => ({ status: 500, body: { code: 'BOOM', error: 'db down' } }))
    const result = await runWrp(['tags', 'list'], { stub: server })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1)
    expect(errorEnvelope(result)).toEqual({
      error: {
        status: 500,
        code: 'BOOM',
        message: 'db down',
        fix: 'read the tag inventory again',
      },
    })
  })

  it('omits code when the API supplied none, keeping status and message', async () => {
    const server = await stub(() => ({ status: 400, body: { error: 'bad filter' } }))
    const result = await runWrp(['tags', 'list'], { stub: server })

    expect(result.code).toBe(1)
    expect(errorEnvelope(result)).toEqual({
      error: { status: 400, message: 'bad filter', fix: 'read the tag inventory again' },
    })
  })
})

describe('credential resolution order', () => {
  it('env PAT and base URL override machine credentials', async () => {
    const server = await stub(() => ({ status: 200, body: { tags: [] } }))
    const home = await makeHome({
      machine: { pat: 'machine_token', baseUrl: 'http://127.0.0.1:9' },
    })

    const result = await runWrp(['tags', 'list'], {
      stub: server,
      home,
      env: { WEEKLY_REPORTER_PAT: 'env_token' },
    })

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].headers.authorization).toBe('Bearer env_token')
  })

  it('falls back to machine credentials when the env is empty', async () => {
    const server = await stub(() => ({ status: 200, body: { tags: [] } }))
    const home = await makeHome({ machine: { pat: 'machine_token', baseUrl: server.url } })

    const result = await runWrp(['tags', 'list'], { home })

    expect(result.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].headers.authorization).toBe('Bearer machine_token')
  })

  it('honours the WEEKLY_REPORTER_URL alias', async () => {
    const server = await stub(() => ({ status: 200, body: { tags: [] } }))

    const result = await runWrp(['tags', 'list'], {
      env: { WEEKLY_REPORTER_URL: server.url, WEEKLY_REPORTER_PAT: 'alias_token' },
    })

    expect(result.code).toBe(0)
    expect(server.requests[0].headers.authorization).toBe('Bearer alias_token')
  })

  it('defaults the base URL to the dev port when nothing is configured', async () => {
    // If 6868 is free, bind the stub there: a received request proves the
    // default without any env/config. If a dev server already owns the port,
    // the run answers 401 (or is unreachable) and the line still names it.
    const devServer = await listenOnDevPort()
    if (devServer) {
      stubs.push(devServer.server)
      const result = await runWrp(['tags', 'list'], { home: await makeHome() })
      expect(result.code).toBe(0)
      expect(devServer.requests).toHaveLength(1)
      expect(devServer.requests[0].method).toBe('GET')
      expect(devServer.requests[0].url).toBe('/api/tags')
      return
    }

    const result = await runWrp(['tags', 'list'], { home: await makeHome() })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('http://localhost:6868')
  })
})

describe('self-report headers', () => {
  it('names the runtime in the agent header', async () => {
    const server = await stub(() => ({ status: 200, body: { tags: [] } }))

    await runWrp(['tags', 'list'], { stub: server, env: { CLAUDECODE: '1' } })
    expect(server.requests[0].headers['x-weekly-reporter-agent']).toBe('weekly-reporter/claude-code')

    await runWrp(['tags', 'list'], { stub: server })
    expect(server.requests[1].headers['x-weekly-reporter-agent']).toBe('weekly-reporter/unknown')
  })

  it('sends the cwd as printable ASCII', async () => {
    const server = await stub(() => ({ status: 200, body: { tags: [] } }))
    const asciiDir = await mkdtemp(join(tmpdir(), 'wrp-cwd-'))
    const unicodeDir = join(asciiDir, '工作目录')
    await mkdir(unicodeDir)

    await runWrp(['tags', 'list'], { stub: server, cwd: asciiDir })
    expect(await realpath(asciiDir)).toBe(server.requests[0].headers['x-weekly-reporter-cwd'])

    await runWrp(['tags', 'list'], { stub: server, cwd: unicodeDir })
    const sent = server.requests[1].headers['x-weekly-reporter-cwd']
    expect(sent).toMatch(/^[\x20-\x7e]+$/)
    expect(sent).toContain('?')
    expect(sent).not.toContain('工')
  })
})

describe('reference verb (tags list) used by the seam', () => {
  it('prints one line per tag plus the list footer', async () => {
    const server = await stub(() => ({
      status: 200,
      body: {
        tags: [
          { name: '调试', count: 12 },
          { name: 'worklog', count: 1 },
        ],
      },
    }))

    const result = await runWrp(['tags', 'list'], { stub: server, env: { WEEKLY_REPORTER_PAT: 't' } })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('#调试 — 12 event(s)')
    expect(result.stdout).toContain('#worklog — 1 event(s)')
    expect(result.stdout).toContain('— 2 tag(s)')
    expect(server.requests[0].method).toBe('GET')
    expect(server.requests[0].url).toBe('/api/tags')
  })
})

/** Bind 0.0.0.0:6868 for the default-port test; null when the port is taken. */
async function listenOnDevPort() {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tags: [] }))
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(6868, resolve)
    })
  } catch {
    return null
  }
  return { server, requests }
}
