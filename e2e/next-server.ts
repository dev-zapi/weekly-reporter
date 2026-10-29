import path from 'node:path'

export type NextServerMode = 'development' | 'production'

/**
 * Default is production. `E2E_SERVER_MODE=development` is the explicit
 * downgrade; unset — or any value that is not `development` — falls back to
 * production, which is the mode that both fits the 8G scope and finishes the
 * suite fastest (measurements on `bundlerArgs`). `CI` no longer gets its own
 * branch: it was only inferred to get production runs, so the inference is now
 * simply the default.
 */
function resolveServerMode(): NextServerMode {
  return process.env.E2E_SERVER_MODE === 'development' ? 'development' : 'production'
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
 * Decision record — the default is production + Turbopack; the escape hatches
 * are `E2E_SERVER_MODE=development` (whose own bundler default is webpack) and
 * `E2E_BUNDLER=webpack|turbopack` (an explicit value wins in both modes).
 *
 * All four combinations measured on this machine, default suite, serial
 * workers, every run wrapped in `scripts/run-e2e.mjs` (8G `MemoryMax`,
 * 300% `CPUQuota`):
 *
 * - dev + webpack: 25 passed, 0 failed in about 2m30s, `memory.peak` 8.0G
 *   saturated, `oom_kill 0` only because swap absorbed the difference. Not the
 *   slowest of the four — the production rows pay for a full `next build` that
 *   a dev run never does.
 * - dev + Turbopack: does not survive 8G. OOM-killed twice (dead at test 16 of
 *   27 after 3m35s, 8.0G peak plus 2.1G swap peak). At 12G it finally
 *   completes in 10m07s with the peak again saturated, and `legacy-migration`
 *   turns red because Turbopack's colder start blows that spec's 30s timeout.
 *   `E2E_DEV_MEM` (`--max-old-space-size`) cannot bound it: the memory lives
 *   in the native binary, not the V8 heap.
 * - production + webpack: 25/25, peak 7.7–8.0G — correct, but no headroom left.
 * - production + Turbopack: 25/25, peak 6.1–6.2G — the faster of the two
 *   production rows, and the only combination with room under the ceiling.
 *   Hence the default.
 *
 * Do not change either default without re-measuring `memory.peak` / `oom_kill`
 * from the run's cgroup.
 */
function resolveBundler(mode: NextServerMode): 'webpack' | 'turbopack' {
  const explicit = process.env.E2E_BUNDLER
  if (explicit === 'webpack' || explicit === 'turbopack') return explicit
  return mode === 'production' ? 'turbopack' : 'webpack'
}

/**
 * Turbopack is the Next 16 default, so it needs no flag; webpack is opted into
 * with `--webpack` for both `next build` and `next dev` (Next 16 docs,
 * 01-app/01-getting-started/01-installation.md).
 */
export function bundlerArgs(mode: NextServerMode = nextServerMode): string[] {
  return resolveBundler(mode) === 'webpack' ? WEBPACK_ARGS : []
}

/**
 * Build and serve resolve the bundler identically: a webpack build served by
 * Turbopack (or the other way round) is not a supported combination.
 */
export function nextBuildArgs(mode: NextServerMode = nextServerMode): string[] {
  return [path.resolve('node_modules/next/dist/bin/next'), 'build', ...bundlerArgs(mode)]
}

export function nextServeArgs(port: number, mode = nextServerMode): string[] {
  const command = mode === 'production' ? 'start' : 'dev'
  // `next start` serves the prebuilt output, so only `next dev` takes the flag.
  const bundler = mode === 'development' ? bundlerArgs(mode) : []
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
 * Production mode (the default, or `E2E_SERVER_MODE=production` explicitly)
 * builds and then serves the prebuilt output, which is the only way to measure
 * the suite against production bundles instead of the dev server. Flags are
 * forwarded through `npm run build -- <flags>`, so they land on the trailing
 * `next build` of that script — keep the build step last in `package.json` or
 * the bundler selection silently stops applying.
 */
export function nextWebServerCommand(port: number, mode = nextServerMode): string {
  const serve = [process.execPath, ...nextServeArgs(port, mode)].map(shellQuote).join(' ')
  if (mode === 'development') return serve
  const buildFlags = bundlerArgs(mode).map(shellQuote)
  // `--` only when there are flags to forward: a bare trailing `--` is accepted
  // by npm but reads as a typo.
  const build = ['npm', 'run', 'build', ...(buildFlags.length > 0 ? ['--', ...buildFlags] : [])].join(' ')
  return `${build} && ${serve}`
}
