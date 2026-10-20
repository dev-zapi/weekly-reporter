#!/usr/bin/env node
// Configure machine-level PAT credentials in ~/.config/weekly-reporter/auth.json
//
// Usage:
//   node scripts/configure-pat.mjs --pat <token> [--base-url <url>]
//   node scripts/configure-pat.mjs --base-url <url> [--name <name>]
//   node scripts/configure-pat.mjs --show
//   node scripts/configure-pat.mjs --clear
//
// Zero dependencies, Node 18+.

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'weekly-reporter')
const CONFIG_PATH = join(CONFIG_DIR, 'auth.json')

/**
 * Read the auth.json file and return its parsed content.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readConfig(path = CONFIG_PATH) {
  try {
    if (!existsSync(path)) return null
    const content = readFileSync(path, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Write the config to disk with 600 permissions.
 * Creates the directory if needed. Preserves all existing fields.
 */
export function writeConfig(config, path = CONFIG_PATH) {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const isNew = !existsSync(path)
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })

  // Ensure permissions even if file existed (in case it had wrong perms)
  if (!isNew) {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Ignore chmod failures on some filesystems
    }
  }
}

/**
 * Update only the machine field, preserving everything else.
 * Returns the new config object.
 */
export function updateMachineField(config, machineUpdate) {
  const current = config ?? {}
  const machine = { ...(current.machine ?? {}), ...machineUpdate }

  // Remove undefined values (for --clear)
  for (const key of Object.keys(machine)) {
    if (machine[key] === undefined) {
      delete machine[key]
    }
  }

  // If machine is empty after cleanup, remove it entirely
  if (Object.keys(machine).length === 0) {
    const { machine: _, ...rest } = current
    return rest
  }

  return {
    ...current,
    machine,
  }
}

/**
 * Mask a PAT for display: show first 6 chars + last 4 chars.
 * Returns '****' if the token is too short.
 */
export function maskPat(pat) {
  if (!pat || typeof pat !== 'string' || pat.length < 10) {
    return '****'
  }
  return `${pat.slice(0, 6)}...${pat.slice(-4)}`
}

/**
 * Get file permissions as an octal string (e.g., '600').
 */
export function getFilePermissions(path) {
  try {
    const stats = statSync(path)
    return (stats.mode & 0o777).toString(8)
  } catch {
    return null
  }
}

/**
 * Interactive mode: create a PAT via the API using the startup password.
 * Returns the new PAT token or null on failure.
 */
async function interactiveCreatePat(baseUrl, name) {
  const readline = await import('node:readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  return new Promise((resolve) => {
    rl.question('Enter startup password: ', (password) => {
      rl.close()

      if (!password) {
        console.error('Error: password is required')
        resolve(null)
        return
      }

      // Call POST /api/auth/pats with Bearer password
      fetch(`${baseUrl}/api/auth/pats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${password}`,
        },
        body: JSON.stringify({ name }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            console.error(`Error: Failed to create PAT (${res.status})`)
            if (body.error) console.error(body.error)
            resolve(null)
            return
          }

          const data = await res.json()
          resolve(data.token)
        })
        .catch((err) => {
          console.error('Error: Failed to connect to server')
          console.error(err.message)
          resolve(null)
        })
    })
  })
}

/**
 * Mode: --pat <token> [--base-url <url>]
 * Write the PAT (and optionally baseUrl) to the machine config.
 */
async function handlePatMode(pat, baseUrl, configPath) {
  const config = readConfig(configPath)
  const machineUpdate = { pat }
  if (baseUrl !== undefined) {
    machineUpdate.baseUrl = baseUrl
  }

  const newConfig = updateMachineField(config, machineUpdate)
  writeConfig(newConfig, configPath)

  console.log('✓ PAT configured')
  console.log(`  Token: ${maskPat(pat)}`)
  if (baseUrl !== undefined) {
    console.log(`  Base URL: ${baseUrl}`)
  }
}

/**
 * Mode: --base-url <url> (without --pat)
 * Interactive: prompt for password, create PAT via API.
 */
async function handleBaseUrlMode(baseUrl, name, configPath) {
  const token = await interactiveCreatePat(baseUrl, name)
  if (!token) {
    process.exit(1)
  }

  const config = readConfig(configPath)
  const newConfig = updateMachineField(config, {
    baseUrl,
    pat: token,
  })
  writeConfig(newConfig, configPath)

  console.log('✓ PAT configured via API')
  console.log(`  Token: ${maskPat(token)}`)
  console.log(`  Base URL: ${baseUrl}`)
}

/**
 * Mode: --show
 * Print the current config with PAT masked.
 */
function handleShowMode(configPath) {
  const config = readConfig(configPath)

  if (!config || !config.machine) {
    console.log('No machine credentials configured.')
    console.log('Run: node scripts/configure-pat.mjs --pat <token> [--base-url <url>]')
    return
  }

  const perms = getFilePermissions(configPath)
  console.log('Machine credentials:')
  console.log(`  Base URL: ${config.machine.baseUrl ?? '(not set)'}`)
  console.log(`  PAT: ${maskPat(config.machine.pat)}`)
  if (perms) {
    console.log(`  File permissions: ${perms}`)
  }
  if (perms !== '600') {
    console.warn(`Warning: File permissions should be 600, got ${perms}`)
  }
}

/**
 * Mode: --clear
 * Remove the machine field from the config.
 */
function handleClearMode(configPath) {
  const config = readConfig(configPath)

  if (!config || !config.machine) {
    console.log('No machine credentials to clear.')
    return
  }

  const newConfig = updateMachineField(config, {
    baseUrl: undefined,
    pat: undefined,
  })
  writeConfig(newConfig, configPath)

  console.log('✓ Machine credentials cleared')
}

/**
 * Parse CLI arguments and dispatch to the appropriate mode.
 */
async function main(argv) {
  const args = argv.slice(2)
  let mode = null
  let pat = null
  let baseUrl = null
  let name = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--pat') {
      mode = 'pat'
      pat = args[++i]
      if (!pat) {
        console.error('Error: --pat requires a value')
        process.exit(1)
      }
    } else if (arg === '--base-url') {
      baseUrl = args[++i]
      if (!baseUrl) {
        console.error('Error: --base-url requires a value')
        process.exit(1)
      }
      if (!mode) mode = 'base-url'
    } else if (arg === '--name') {
      name = args[++i]
      if (!name) {
        console.error('Error: --name requires a value')
        process.exit(1)
      }
    } else if (arg === '--show') {
      mode = 'show'
    } else if (arg === '--clear') {
      mode = 'clear'
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  node scripts/configure-pat.mjs --pat <token> [--base-url <url>]
  node scripts/configure-pat.mjs --base-url <url> [--name <name>]
  node scripts/configure-pat.mjs --show
  node scripts/configure-pat.mjs --clear

Options:
  --pat <token>       Set the PAT directly
  --base-url <url>    Set the base URL (interactive PAT creation if no --pat)
  --name <name>       PAT name for interactive creation (default: <hostname>-cli)
  --show              Show current config with masked PAT
  --clear             Remove machine credentials
  -h, --help          Show this help message`)
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }

  if (!mode) {
    console.error('Error: specify --pat, --base-url, --show, or --clear')
    console.error('Run with --help for usage')
    process.exit(1)
  }

  // Default name for interactive PAT creation
  if (mode === 'base-url' && !name) {
    name = `${hostname()}-cli`
  }

  switch (mode) {
    case 'pat':
      await handlePatMode(pat, baseUrl, CONFIG_PATH)
      break
    case 'base-url':
      await handleBaseUrlMode(baseUrl, name, CONFIG_PATH)
      break
    case 'show':
      handleShowMode(CONFIG_PATH)
      break
    case 'clear':
      handleClearMode(CONFIG_PATH)
      break
  }
}

// CLI entry point
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((err) => {
    console.error('Unexpected error:', err)
    process.exit(1)
  })
}
