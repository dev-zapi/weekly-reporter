import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '@/lib/paths'
import {
  ensureStartupPassword,
  getAuthConfigPath,
  readMachineCredential,
  readStartupPassword,
  updateMachineCredential,
} from './password'

const authPath = getAuthConfigPath()

function clearAuthFile() {
  if (fs.existsSync(authPath)) fs.rmSync(authPath)
}

describe('startup password', () => {
  beforeEach(() => {
    clearAuthFile()
  })

  afterEach(() => {
    clearAuthFile()
  })

  it('generates a 48-character alphanumeric password when the file is missing', async () => {
    const password = await ensureStartupPassword()

    expect(password).toHaveLength(48)
    expect(password).toMatch(/^[A-Za-z0-9]+$/)
    expect(fs.existsSync(authPath)).toBe(true)
  })

  it('persists the password so it survives across calls', async () => {
    const first = await ensureStartupPassword()
    const second = await ensureStartupPassword()

    expect(second).toBe(first)
    expect(readStartupPassword()).toBe(first)
  })

  it('does not regenerate when the file already holds a password', async () => {
    await ensureStartupPassword()
    const stored = readStartupPassword()

    const again = await ensureStartupPassword()

    expect(again).toBe(stored)
  })

  it('regenerates when the password field is missing from an existing file', async () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ machine: { baseUrl: 'http://localhost:6868' } }))

    const password = await ensureStartupPassword()

    expect(password).toHaveLength(48)
    // 写入不能覆盖同文件的 machine 字段
    expect(readMachineCredential()).toEqual({ baseUrl: 'http://localhost:6868' })
  })

  it('writes the auth file with owner-only permissions', async () => {
    await ensureStartupPassword()

    const mode = fs.statSync(authPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates the config directory with owner-only permissions', async () => {
    await ensureStartupPassword()

    const mode = fs.statSync(CONFIG_DIR).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('returns null when the password file is missing', () => {
    expect(readStartupPassword()).toBeNull()
  })

  it('returns null when the password file is corrupted', () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(authPath, '{not json')

    expect(readStartupPassword()).toBeNull()
  })

  it('returns null when the password field is empty', () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ password: '' }))

    expect(readStartupPassword()).toBeNull()
  })
})

describe('machine credential', () => {
  beforeEach(() => {
    clearAuthFile()
  })

  afterEach(() => {
    clearAuthFile()
  })

  it('keeps the startup password when the machine credential is written', async () => {
    const password = await ensureStartupPassword()

    updateMachineCredential({ baseUrl: 'http://localhost:6868', pat: 'wrp_example' })

    expect(readStartupPassword()).toBe(password)
    expect(readMachineCredential()).toEqual({
      baseUrl: 'http://localhost:6868',
      pat: 'wrp_example',
    })
  })

  it('stores the machine credential in the same file as the password', async () => {
    await ensureStartupPassword()
    updateMachineCredential({ pat: 'wrp_example' })

    const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8'))
    expect(raw.machine.pat).toBe('wrp_example')
    expect(typeof raw.password).toBe('string')
  })
})

describe('auth config path', () => {
  it('lives under the config directory', () => {
    expect(path.dirname(authPath)).toBe(CONFIG_DIR)
    expect(path.basename(authPath)).toBe('auth.json')
  })
})
