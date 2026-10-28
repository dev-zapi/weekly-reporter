import path from 'node:path'

export type NextServerMode = 'development' | 'production'

export const nextServerMode: NextServerMode = process.env.CI ? 'production' : 'development'

const DEV_BUNDLER_ARGS = ['--webpack']

/**
 * `--webpack` is deliberate: Turbopack (the Next 16 default) exhausts the e2e
 * memory ceiling. Measured in #64 on this machine, default suite serial, both
 * runs wrapped in `scripts/run-e2e.mjs` (8G `MemoryMax`):
 *
 * - webpack: suite completes (7 passed / 20 failed — the #63 AuthGate reds),
 *   14m38s, cgroup memory.peak 8.0G, no oom_kill
 * - Turbopack: both attempts OOM-killed inside the scope; the dev server hit
 *   4.6G / 5.1G anon-rss at 2.5min / 4.1min and the suite died at test 13 of
 *   27 and 16 of 27
 *
 * `--max-old-space-size` (E2E_DEV_MEM) does not bound Turbopack: its memory
 * lives in the native binary, not the V8 heap. Do not drop the flag without
 * re-measuring `memory.peak` / `oom_kill` from the run's cgroup.
 */
export function devBundlerArgs(): string[] {
  // Escape hatch for re-measuring Turbopack after a Next upgrade.
  return process.env.E2E_BUNDLER === 'turbopack' ? [] : DEV_BUNDLER_ARGS
}

export function nextBuildArgs(): string[] {
  return [path.resolve('node_modules/next/dist/bin/next'), 'build']
}

export function nextServeArgs(port: number, mode = nextServerMode): string[] {
  const command = mode === 'production' ? 'start' : 'dev'
  const bundler = mode === 'development' ? devBundlerArgs() : []
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

export function nextWebServerCommand(port: number, mode = nextServerMode): string {
  const serve = [process.execPath, ...nextServeArgs(port, mode)].map(shellQuote).join(' ')
  if (mode === 'development') return serve
  return `npm run build && ${serve}`
}
