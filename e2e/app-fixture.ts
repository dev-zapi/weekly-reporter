/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture callbacks are not React hooks. */
import { expect, test as base } from '@playwright/test'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { nextBuildArgs, nextServeArgs, nextServerMode } from './next-server'

type WorkerFixtures = { appURL: string }

function runToCompletion(args: string[], options: Parameters<typeof spawn>[2]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options)
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(output)
      else reject(new Error(`Next.js command failed (${signal ?? code ?? 'unknown'}):\n${output}`))
    })
  })
}

/** Runs the generation acceptance seam in a worker-owned Next process and SQLite database. */
export const test = base.extend<Record<never, never>, WorkerFixtures>({
  appURL: [async ({}, use, workerInfo) => {
    const root = await mkdtemp(path.join(process.cwd(), `.e2e-worker-${process.pid}-${workerInfo.workerIndex}-`))
    const app = path.join(root, 'app')
    await mkdir(app)
    for (const file of ['src', 'public', 'drizzle', 'package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs']) {
      await cp(path.resolve(file), path.join(app, file), { recursive: true })
    }
    await symlink(path.resolve('node_modules'), path.join(app, 'node_modules'), 'dir')
    const port = 3200 + workerInfo.workerIndex
    const env = {
      ...process.env,
      E2E_FIXTURES: '1',
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      NEXT_TELEMETRY_DISABLED: '1',
      WR_AUTH_DISABLED: '1',
    }
    if (nextServerMode === 'production') {
      await runToCompletion(nextBuildArgs(), { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    const child = spawn(process.execPath, nextServeArgs(port), {
      cwd: app,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let logs = ''
    child.stdout.on('data', (chunk) => { logs += chunk.toString() })
    child.stderr.on('data', (chunk) => { logs += chunk.toString() })
    const url = `http://127.0.0.1:${port}`
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(logs)
        return fetch(`${url}/api/settings/ai`).then((response) => response.status === 200).catch(() => false)
      }, { timeout: 90_000, message: 'Next.js worker app did not become ready' }).toBeTruthy()
      await use(url)
    } finally {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* The server already exited. */ }
        if (child.exitCode === null) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 5_000)
            child.once('exit', () => {
              clearTimeout(timeout)
              resolve()
            })
          })
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, { scope: 'worker', timeout: process.env.CI ? 300_000 : 120_000 }],
  baseURL: async ({ appURL }, use) => { await use(appURL) },
})

export { expect }
