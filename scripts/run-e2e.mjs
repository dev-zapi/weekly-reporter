#!/usr/bin/env node
// E2E entry point for `npm run test:e2e`.
//
// Why wrap the suite in a systemd scope instead of just running playwright:
// on this workstation a full e2e burst (Chromium workers + next dev) has hit
// the machine-wide memory limit and the OOM killer took down *unrelated*
// processes (agent sessions, terminal multiplexers). Wrapping the whole
// process tree in a cgroup scope means the same pressure kills only the tests
// (`MemoryMax`), while `CPUQuota` keeps the desktop responsive. When
// systemd-run is unavailable (other machines, future CI) we run playwright
// plain — the config-level caps (workers / node heap) still apply.
//
// Usage:
//   node scripts/run-e2e.mjs                  # default suite, wrapped
//   node scripts/run-e2e.mjs -c e2e/auth.config.ts
// Env knobs: E2E_MEM_MAX (default 8G), E2E_CPU_QUOTA (default 300%),
//            E2E_NO_SCOPE=1 to skip the cgroup wrapper explicitly.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MEM_MAX = process.env.E2E_MEM_MAX ?? '8G'
const CPU_QUOTA = process.env.E2E_CPU_QUOTA ?? '300%'
// Anchored to this file, not to cwd: `npm --prefix`/editor runs from another
// directory must still find the same Playwright install.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLAYWRIGHT_CLI = path.resolve(SCRIPT_DIR, '../node_modules/@playwright/test/cli.js')
const IN_SCOPE_FLAG = 'E2E_WRAPPED_IN_SCOPE'

function readScopeStats() {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'))
    if (!line) return null
    const dir = `/sys/fs/cgroup${line.slice(3)}`
    const read = (file) => {
      try {
        return readFileSync(`${dir}/${file}`, 'utf8').trim()
      } catch {
        return null
      }
    }
    // null (unreadable) must not become 0: "peak 0 MiB" reads as a real low
    // peak, which is the opposite of what a missing counter means.
    const peakRaw = read('memory.peak')
    const peak = peakRaw === null ? null : Number(peakRaw)
    const events = read('memory.events')
    // oom_kill > 0 means the ceiling actually had to kill something inside
    // the scope — that is the whole point of the wrapper, so surface it.
    const oomKill = events?.match(/^oom_kill (\d+)$/m)?.[1] ?? '0'
    const maxEvents = events?.match(/^max (\d+)$/m)?.[1] ?? '0'
    return { cgroup: line.slice(3), peak, oomKill, maxEvents }
  } catch {
    return null
  }
}

function formatBytes(bytes) {
  if (bytes === null) return 'n/a'
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`
}

function runPlaywright(extraArgs) {
  const result = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) console.error(`[run-e2e] ${result.error.message}`)
  return result.status ?? 1
}

// Returns null when the scope probe works, else a human-readable reason. The
// reason matters: a bad E2E_MEM_MAX or an unreachable user manager used to
// degrade silently, i.e. the run quietly lost its hard memory ceiling.
function scopeProbeFailure() {
  // Probe with the same properties as the real run: this also catches
  // systemd-run that exists but has no reachable user manager (no session
  // bus), where `--user --scope` fails before the tests start.
  const probe = spawnSync(
    'systemd-run',
    [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '-p',
      `MemoryMax=${MEM_MAX}`,
      '-p',
      `CPUQuota=${CPU_QUOTA}`,
      process.execPath,
      '-e',
      '',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  )
  if (probe.status === 0) return null
  if (probe.error?.code === 'ENOENT') return 'systemd-run is not installed'
  const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit status ${probe.status}`
  return `scope probe failed (${detail})`
}

function runInsideScope(extraArgs) {
  const self = fileURLToPath(import.meta.url)
  const result = spawnSync(
    'systemd-run',
    [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '-p',
      `MemoryMax=${MEM_MAX}`,
      '-p',
      `CPUQuota=${CPU_QUOTA}`,
      process.execPath,
      self,
      ...extraArgs,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, [IN_SCOPE_FLAG]: '1' },
    },
  )
  return result.status ?? 1
}

const extraArgs = process.argv.slice(2)

if (process.env[IN_SCOPE_FLAG] === '1') {
  const status = runPlaywright(extraArgs)
  const stats = readScopeStats()
  if (stats) {
    console.log(
      `[run-e2e] cgroup ${stats.cgroup} memory.peak=${formatBytes(stats.peak)} ` +
        `max=${stats.maxEvents} oom_kill=${stats.oomKill}`,
    )
  }
  // Exit code only: `process.exit()` here would truncate the stats line when
  // stdout is a pipe (the write is still buffered).
  process.exitCode = status
} else if (process.env.E2E_NO_SCOPE === '1') {
  console.log('[run-e2e] running playwright without a cgroup scope (workers/heap caps still apply)')
  process.exitCode = runPlaywright(extraArgs)
} else {
  const scopeFailure = scopeProbeFailure()
  if (scopeFailure === null) {
    process.exitCode = runInsideScope(extraArgs)
  } else {
    console.log(
      `[run-e2e] running playwright without a cgroup scope (workers/heap caps still apply): ${scopeFailure}`,
    )
    process.exitCode = runPlaywright(extraArgs)
  }
}
