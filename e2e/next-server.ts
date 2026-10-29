import path from 'node:path'

export type NextServerMode = 'development' | 'production'

/**
 * `E2E_SERVER_MODE=production|development` overrides the CI inference so the
 * production path can be measured locally — `CI=1` is not usable for that
 * because Playwright also reads it (retries, forbidOnly, workers). Local
 * default is unchanged: development unless CI is set.
 */
function resolveServerMode(): NextServerMode {
  const explicit = process.env.E2E_SERVER_MODE
  if (explicit === 'production' || explicit === 'development') return explicit
  return process.env.CI ? 'production' : 'development'
}

export const nextServerMode: NextServerMode = resolveServerMode()

/**
 * The production webServer command runs a full `next build` before serving
 * (under the run-e2e scope that means CPUQuota 300%, so minutes), which the
 * dev-mode 2 minute budget does not cover.
 */
export function webServerTimeout(mode: NextServerMode = nextServerMode): number {
  return mode === 'production' ? 5 * 60 * 1000 : 120 * 1000
}

const WEBPACK_ARGS = ['--webpack']

/**
 * `--webpack` is deliberate: Turbopack (the Next 16 default) exhausts the e2e
 * memory ceiling. Measured on this machine, default suite serial, every run
 * wrapped in `scripts/run-e2e.mjs`:
 *
 * #64 (E2E_DEV_MEM 2048, 8G `MemoryMax`):
 * - webpack: suite completes (7 passed / 20 failed — the #63 AuthGate reds),
 *   14m38s, cgroup memory.peak 8.0G, no oom_kill
 * - Turbopack: both attempts OOM-killed inside the scope; the dev server hit
 *   4.6G / 5.1G anon-rss at 2.5min / 4.1min and the suite died at test 13 of
 *   27 and 16 of 27
 *
 * #64 retest (E2E_DEV_MEM 4096):
 * - webpack 8G: unchanged baseline — 7 passed / 20 failed, 14m42s, peak 8.0G
 *   (ceiling saturated), oom_kill 0
 * - Turbopack 8G: still OOM-killed inside the scope, dead at test 16 of 27
 *   after 3m35s, 8.0G peak plus 2.1G swap peak
 * - Turbopack 12G: the suite finally completes (10m07s, peak 12.0G also
 *   saturated, no oom_kill) but the red set grows to 21: `legacy-migration`
 *   times out spawning its own Turbopack dev server. Reproduced twice in
 *   isolation, so Turbopack's colder start exceeds that spec's 30s test
 *   timeout rather than being a flake.
 *
 * `--max-old-space-size` (E2E_DEV_MEM) does not bound Turbopack: its memory
 * lives in the native binary, not the V8 heap — raising the ceiling from 8G to
 * 12G did not shrink the footprint, it just moved where the run died. Do not
 * drop the flag without re-measuring `memory.peak` / `oom_kill` from the run's
 * cgroup.
 */
export function bundlerArgs(): string[] {
  // Escape hatch for re-measuring Turbopack after a Next upgrade.
  return process.env.E2E_BUNDLER === 'turbopack' ? [] : WEBPACK_ARGS
}

/**
 * Production builds follow the same `E2E_BUNDLER` switch as dev: `next build
 * --webpack` is the documented equivalent of `next dev --webpack` (Next 16
 * docs, 01-installation.md). Build and serve must agree — a webpack build
 * served by Turbopack (or vice versa) is not a supported combination.
 */
export function nextBuildArgs(): string[] {
  return [path.resolve('node_modules/next/dist/bin/next'), 'build', ...bundlerArgs()]
}

export function nextServeArgs(port: number, mode = nextServerMode): string[] {
  const command = mode === 'production' ? 'start' : 'dev'
  // `next start` serves the prebuilt output, so only `next dev` takes the flag.
  const bundler = mode === 'development' ? bundlerArgs() : []
  return [
    path.resolve('node_modules/next/dist/bin/next'),
    command,
    ...bundler,
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Production mode (`E2E_SERVER_MODE=production`, or CI) builds and then serves
 * the prebuilt output, which is the only way to measure the suite against
 * webpack/Turbopack production bundles instead of the dev server. Flags are
 * forwarded through `npm run build -- <flags>`, so they land on the trailing
 * `next build` of that script — keep the build step last in `package.json` or
 * the bundler selection silently stops applying.
 */
export function nextWebServerCommand(port: number, mode = nextServerMode): string {
  const serve = [process.execPath, ...nextServeArgs(port, mode)].map(shellQuote).join(' ')
  if (mode === 'development') return serve
  const buildFlags = bundlerArgs().map(shellQuote)
  // `--` only when there are flags to forward: a bare trailing `--` is accepted
  // by npm but reads as a typo.
  const build = ['npm', 'run', 'build', ...(buildFlags.length > 0 ? ['--', ...buildFlags] : [])].join(' ')
  return `${build} && ${serve}`
}
