// Credential resolution for the wrp client.
//
// Ported from the skill AUTH-BLOCK (the old per-skill `client.mjs` copies).
// The order is fixed: env > machine credentials > dev default. Resolution is
// lazy so a command reads the current environment/config at call time, and a
// missing credential never crashes - it only means the API answers 401.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BASE_URL = 'http://localhost:6868'
export const SKILL_NAME = 'weekly-reporter'

/** `~/.config/weekly-reporter/auth.json` - the machine credential file. */
export function configPath() {
  return join(homedir(), '.config', 'weekly-reporter', 'auth.json')
}

let cachedMachineConfig

/**
 * The `machine` member of the auth config, or null when the file is missing,
 * unreadable or malformed. Never throws: a missing credential must not crash a
 * command, it only means the API answers 401.
 */
export function readMachineConfig() {
  if (cachedMachineConfig !== undefined) return cachedMachineConfig
  const path = configPath()
  try {
    cachedMachineConfig = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8'))?.machine ?? null)
      : null
  } catch {
    cachedMachineConfig = null
  }
  return cachedMachineConfig
}

/** env WEEKLY_REPORTER_BASE_URL (alias WEEKLY_REPORTER_URL) > machine.baseUrl > dev default. */
export function resolveBaseUrl() {
  return (
    process.env.WEEKLY_REPORTER_BASE_URL ||
    process.env.WEEKLY_REPORTER_URL ||
    readMachineConfig()?.baseUrl ||
    DEFAULT_BASE_URL
  )
}

/** env WEEKLY_REPORTER_PAT > machine.pat > null (the API then answers 401). */
export function resolvePat() {
  return process.env.WEEKLY_REPORTER_PAT || readMachineConfig()?.pat || null
}

export function resolveCredentials() {
  return { baseUrl: resolveBaseUrl(), pat: resolvePat() }
}

/**
 * Which agent runtime drives this command. zellij is deliberately not mapped:
 * it is a terminal multiplexer, not an agent.
 */
export function detectAgentName() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude-code'
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex'
  if (process.env.OPENCODE || process.env.OPENCODE_BIN) return 'opencode'
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  return 'unknown'
}
