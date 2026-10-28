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
const PLAYWRIGHT_CLI = path.resolve('node_modules/@playwright/test/cli.js')
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
    const peak = Number(read('memory.peak'))
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
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`
}

function runPlaywright(extraArgs) {
  const result = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  })
  return result.status ?? 1
}

function canUseSystemdScope() {
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
    { stdio: 'ignore' },
  )
  return !probe.error && probe.status === 0
}

function runInsideScope(extraArgs) {
  const self = fileURLToPath(import.meta.url)
  const result = spawnSync(
    'systemd-run',
    [
      '--user',
      '--scope',
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
  process.exit(status)
}

if (process.env.E2E_NO_SCOPE === '1' || !canUseSystemdScope()) {
  console.log('[run-e2e] running playwright without a cgroup scope (workers/heap caps still apply)')
  process.exit(runPlaywright(extraArgs))
}

process.exit(runInsideScope(extraArgs))
