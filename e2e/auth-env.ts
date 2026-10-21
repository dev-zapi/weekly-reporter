import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBase62 } from '../src/lib/auth/random'

/**
 * Shared environment for the auth-enabled Playwright suite.
 *
 * The auth suite runs against a separate Next server (auth ENABLED, unlike the
 * default `playwright.config.ts` which sets `WR_AUTH_DISABLED=1`) with isolated
 * XDG dirs, so the generated startup password / database never touch the
 * default suite or the developer's real config.
 *
 * Paths are deterministic (no run id): `auth.config.ts` wipes the root at load
 * time — which runs once in the runner process before the webServer plugin
 * starts — while the spec workers recompute the same paths to read the
 * password file. Workers do not re-evaluate the config (Playwright serialises
 * it), so the wipe never races a running server.
 *
 * 密码写入：dev 模式下 instrumentation.register() 不一定在 Playwright 启动的
 * webServer 里被调用（实测 dev + webpack 不触发）。`preparePassword()` 由
 * auth.config.ts 在 reset 后调用，按 password.ts 同样的算法写一份 48 位 base62
 * 密码到 auth.json。服务端的 `ensureStartupPassword` 启动后读到已有密码会跳过
 * 生成，行为与原生流程一致。
 */
const AUTH_E2E_ROOT = path.join(os.tmpdir(), 'weekly-reporter-auth-e2e')

export const AUTH_E2E_PORT = 3201
export const AUTH_E2E_BASE_URL = `http://127.0.0.1:${AUTH_E2E_PORT}`
export const AUTH_XDG_CONFIG_HOME = path.join(AUTH_E2E_ROOT, 'config')
export const AUTH_XDG_DATA_HOME = path.join(AUTH_E2E_ROOT, 'data')
export const AUTH_CONFIG_DIR = path.join(AUTH_XDG_CONFIG_HOME, 'weekly-reporter')
export const AUTH_CONFIG_FILE = path.join(AUTH_CONFIG_DIR, 'auth.json')

/** Remove the isolated XDG dirs so each run starts from a clean slate. */
export function resetAuthE2eRoot(): void {
  fs.rmSync(AUTH_E2E_ROOT, { recursive: true, force: true })
}

/**
 * Generate the startup password file with a fresh 48-char base62 token.
 * Uses the same `randomBase62` helper as `src/lib/auth/password.ts` so the
 * server's `ensureStartupPassword` treats it as already initialised.
 */
export function preparePassword(): string {
  const password = randomBase62(48)
  fs.mkdirSync(AUTH_CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(AUTH_CONFIG_FILE, `${JSON.stringify({ password }, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(AUTH_CONFIG_FILE, 0o600)
  return password
}

/** Read the startup password from the isolated config dir. */
export function readStartupPassword(): string {
  const raw = fs.readFileSync(AUTH_CONFIG_FILE, 'utf-8')
  const parsed = JSON.parse(raw) as { password?: string }
  if (!parsed.password) throw new Error(`No startup password in ${AUTH_CONFIG_FILE}`)
  return parsed.password
}
