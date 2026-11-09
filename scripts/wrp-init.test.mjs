// Behaviour tests for `wrp init` (#121) — the machine-credential (机器级凭据)
// provisioning command that absorbs the retired repo-root credential script.
//
// Same seam as the rest of the client: the real `wrp` entry point as a
// subprocess, with HOME pointed at a throwaway directory so the machine config
// under test is `$HOME/.config/weekly-reporter/auth.json` and no real credential
// is ever read or written. The interactive mode is driven through stdin, which
// is what an agent's `! node …/wrp.mjs init` handoff does.

import { describe, it, expect, afterEach } from 'vitest'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { errorLines, makeHome, runWrp, startStubServer } from './wrp-cli-harness.mjs'

const stubs = []

async function stub(respond) {
  const server = await startStubServer(respond)
  stubs.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

function configPathIn(home) {
  return join(home, '.config', 'weekly-reporter', 'auth.json')
}

async function readConfigIn(home) {
  return JSON.parse(await readFile(configPathIn(home), 'utf8'))
}

async function modeOf(path) {
  return (await stat(path)).mode & 0o777
}

describe('wrp init --pat', () => {
  it('stores the token with an optional base URL, masked in the output', async () => {
    const home = await makeHome()
    const token = 'wrp_1234567890abcdef'

    const result = await runWrp(['init', '--pat', token, '--base-url', 'http://127.0.0.1:7021'], { home })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('✓ machine credential stored: wrp_12...cdef')
    expect(result.stdout).toContain('http://127.0.0.1:7021')
    expect(result.stdout).not.toContain(token)
    expect(await readConfigIn(home)).toEqual({
      machine: { pat: token, baseUrl: 'http://127.0.0.1:7021' },
    })
  })

  it('writes JSON with a trailing newline, 0600 on the file and 0700 on the directory', async () => {
    const home = await makeHome()

    await runWrp(['init', '--pat', 'wrp_1234567890abcdef'], { home })

    const path = configPathIn(home)
    expect(await readFile(path, 'utf8')).toMatch(/\n$/)
    expect(JSON.stringify(await readConfigIn(home))).toBeTypeOf('string')
    expect(await modeOf(path)).toBe(0o600)
    expect(await modeOf(dirname(path))).toBe(0o700)
  })

  it('corrects a loosened 644 file back to 600 on the next write', async () => {
    const machine = { pat: 'wrp_old_0000000000', baseUrl: 'http://127.0.0.1:7021' }
    const home = await makeHome({ machine })
    const path = configPathIn(home)
    await chmod(path, 0o644)
    expect(await modeOf(path)).toBe(0o644)

    const result = await runWrp(['init', '--pat', 'wrp_new_1111111111'], { home })

    expect(result.code).toBe(0)
    expect(await modeOf(path)).toBe(0o600)
    expect(await readConfigIn(home)).toEqual({
      machine: { pat: 'wrp_new_1111111111', baseUrl: 'http://127.0.0.1:7021' },
    })
  })
})

describe('wrp init --show', () => {
  it('prints the base URL and a masked PAT, never the token itself', async () => {
    const machine = { pat: 'wrp_1234567890abcdef', baseUrl: 'http://127.0.0.1:7021' }
    const home = await makeHome({ machine })

    const result = await runWrp(['init', '--show'], { home })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('http://127.0.0.1:7021')
    expect(result.stdout).toContain('wrp_12...cdef')
    expect(result.stdout).not.toContain('wrp_1234567890abcdef')
    expect(result.stdout).toContain('File permissions: 600')
    expect(result.stdout).not.toContain('⚠')
  })

  it('warns when the file is not 600', async () => {
    const machine = { pat: 'wrp_1234567890abcdef', baseUrl: 'http://127.0.0.1:7021' }
    const home = await makeHome({ machine })
    await chmod(configPathIn(home), 0o644)

    const result = await runWrp(['init', '--show'], { home })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('File permissions: 644')
    expect(result.stdout).toContain('⚠ File permissions should be 600, got 644')
    expect(result.stdout).not.toContain('wrp_1234567890abcdef')
  })

  it('reports the empty state without an error when nothing is configured', async () => {
    const result = await runWrp(['init', '--show'], { home: await makeHome() })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('No machine credentials configured')
    expect(result.stderr).toBe('')
  })

  it('says the base URL is unset rather than presenting the default as configured', async () => {
    const home = await makeHome({ machine: { pat: 'wrp_1234567890abcdef' } })

    const result = await runWrp(['init', '--show'], { home })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Base URL: (not set — default http://localhost:6868)')
    expect(result.stdout).toContain('wrp_12...cdef')
  })
})

describe('wrp init --clear', () => {
  it('removes the machine credentials and preserves the password and unknown fields', async () => {
    const home = await makeHome()
    const path = configPathIn(home)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify(
        {
          password: 'startup123',
          unknownField: 'keep me',
          machine: { pat: 'wrp_1234567890abcdef', baseUrl: 'http://127.0.0.1:7021' },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )

    const result = await runWrp(['init', '--clear'], { home })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('✓')
    expect(await readConfigIn(home)).toEqual({ password: 'startup123', unknownField: 'keep me' })
    expect(await modeOf(path)).toBe(0o600)
  })

  it('reports the empty state when there is nothing to clear', async () => {
    const result = await runWrp(['init', '--clear'], { home: await makeHome() })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('No machine credentials to clear')
    expect(result.stderr).toBe('')
  })
})

describe('wrp init --base-url (interactive)', () => {
  it('prompts on stderr, creates a PAT via the API and stores it', async () => {
    const token = 'wrp_freshly_created_9876'
    const server = await stub(() => ({
      status: 201,
      body: { id: 7, name: 'ci-box', token, createdAt: 1 },
    }))
    const home = await makeHome()

    const result = await runWrp(['init', '--base-url', server.url], {
      home,
      input: 'startup-secret\n',
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Enter startup password')
    expect(result.stdout).toContain(`✓ machine credential created via API: ${token.slice(0, 6)}...${token.slice(-4)}`)
    expect(result.stdout).toContain(`Base URL: ${server.url}`)
    expect(result.stdout).not.toContain(token)

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/auth/pats')
    expect(server.requests[0].headers.authorization).toBe('Bearer startup-secret')
    expect(JSON.parse(server.requests[0].body)).toEqual({ name: `${hostname()}-cli` })

    expect(await readConfigIn(home)).toEqual({ machine: { baseUrl: server.url, pat: token } })
  })

  it('uses --name as the PAT name', async () => {
    const server = await stub(() => ({ status: 201, body: { token: 'wrp_named_0000009999' } }))

    await runWrp(['init', '--base-url', server.url, '--name', 'laptop'], {
      home: await makeHome(),
      input: 'pw\n',
    })

    expect(JSON.parse(server.requests[0].body)).toEqual({ name: 'laptop' })
  })

  it('fails cleanly on a wrong startup password, writing no credential', async () => {
    const server = await stub(() => ({ status: 401, body: { error: 'Unauthorized' } }))
    const home = await makeHome()

    const result = await runWrp(['init', '--base-url', server.url], { home, input: 'wrong-pw\n' })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('Enter startup password: \n')
    expect(result.stderr).toContain('✗')
    expect(result.stderr).toContain('401')
    expect(result.stderr).toContain('→')
    expect(result.stdout).not.toContain('✓')
    await expect(readConfigIn(home)).rejects.toThrow()
  })

  it('runs interactively against the resolved base URL when no mode flag is given (the 401 handoff)', async () => {
    const token = 'wrp_handoff_123456789'
    const server = await stub(() => ({ status: 201, body: { token } }))
    const home = await makeHome()

    const result = await runWrp(['init'], { stub: server, home, input: 'pw\n' })

    expect(result.code).toBe(0)
    expect(server.requests[0].url).toBe('/api/auth/pats')
    expect(await readConfigIn(home)).toEqual({ machine: { baseUrl: server.url, pat: token } })
  })
})

describe('wrp init mode handling', () => {
  it('keeps the startup password and unknown fields on a --pat update', async () => {
    const home = await makeHome()
    const path = configPathIn(home)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ password: 'startup123', unknownField: 'keep me', machine: { pat: 'wrp_old_0000000000' } }),
      { mode: 0o600 },
    )

    const result = await runWrp(['init', '--pat', 'wrp_new_1111111111'], { home })

    expect(result.code).toBe(0)
    expect(await readConfigIn(home)).toEqual({
      password: 'startup123',
      unknownField: 'keep me',
      machine: { pat: 'wrp_new_1111111111' },
    })
  })

  it('rejects conflicting modes with one ✗ line and no write', async () => {
    const home = await makeHome()

    const result = await runWrp(['init', '--pat', 'wrp_1234567890abcdef', '--show'], { home })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ conflicting init modes')
    await expect(readConfigIn(home)).rejects.toThrow()
  })

  it('refuses an empty --pat instead of storing an empty credential', async () => {
    const home = await makeHome()

    const result = await runWrp(['init', '--pat', ''], { home })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ missing PAT')
    await expect(readConfigIn(home)).rejects.toThrow()
  })

  it('rejects a stray verb word instead of starting interactive', async () => {
    const home = await makeHome()

    const result = await runWrp(['init', 'foo'], { home, input: 'pw\n' })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ unknown verb: wrp init foo')
    await expect(readConfigIn(home)).rejects.toThrow()
  })

  it('reports an interrupt at the password prompt as cancelled, not as a missing password', async () => {
    const server = await stub()
    const home = await makeHome()

    // stdin stays open so the prompt really waits for the interrupt.
    const result = await runWrp(['init', '--base-url', server.url], {
      home,
      input: null,
      interruptAfterMs: 600,
    })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('✗ cancelled')
    expect(result.stderr).not.toContain('missing startup password')
    expect(server.requests).toHaveLength(0)
    await expect(readConfigIn(home)).rejects.toThrow()
  })
})

describe('provisioning lifecycle', () => {
  it('make --pat provision a working credential, and --clear decommission it', async () => {
    const token = 'wrp_lifecycle_0123456789'
    const server = await stub((request) =>
      request.headers.authorization === `Bearer ${token}`
        ? { status: 200, body: { tags: [{ name: 'x', count: 1 }] } }
        : { status: 401, body: { error: 'Unauthorized' } },
    )
    const home = await makeHome()

    expect((await runWrp(['init', '--pat', token, '--base-url', server.url], { home })).code).toBe(0)

    // No env vars: the command must authenticate from the stored credential.
    const listed = await runWrp(['tags', 'list'], { home })
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('— 1 tag(s)')
    expect(server.requests.at(-1).headers.authorization).toBe(`Bearer ${token}`)

    expect((await runWrp(['init', '--clear'], { home })).code).toBe(0)

    // Decommissioned: the API answers 401 and the handoff points at `wrp init`.
    const afterClear = await runWrp(['tags', 'list'], { home, stub: server })
    expect(afterClear.code).not.toBe(0)
    expect(afterClear.stderr).toContain('✗ unauthorized (HTTP 401)')
    expect(afterClear.stderr).toContain('wrp.mjs" init')
  })
})
