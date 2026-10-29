/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture callbacks are not React hooks. */
import { expect, test as base } from '@playwright/test'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
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
    const port = 3200 + workerInfo.workerIndex
    const env = {
      ...process.env,
      E2E_FIXTURES: '1',
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      NEXT_TELEMETRY_DISABLED: '1',
      WR_AUTH_DISABLED: '1',
    }
    let child!: ChildProcess
    let logs = ''
    // Every step between mkdtemp and a live server (copy error, production build
    // failure, spawn error) throws before the teardown below is reachable, so
    // without this the repo keeps an orphaned `.e2e-worker-*` tree.
    try {
      await mkdir(app)
      for (const file of ['src', 'public', 'drizzle', 'package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs']) {
        await cp(path.resolve(file), path.join(app, file), { recursive: true })
      }
      await symlink(path.resolve('node_modules'), path.join(app, 'node_modules'), 'dir')
      if (nextServerMode === 'production') {
        await runToCompletion(nextBuildArgs(), { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
      }
      child = spawn(process.execPath, nextServeArgs(port), {
        cwd: app,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      child.stdout?.on('data', (chunk) => { logs += chunk.toString() })
      child.stderr?.on('data', (chunk) => { logs += chunk.toString() })
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
    const url = `http://127.0.0.1:${port}`
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(logs)
        return fetch(`${url}/api/settings/ai`).then((response) => response.status === 200).catch(() => false)
      }, { timeout: 90_000, message: 'Next.js worker app did not become ready' }).toBeTruthy()
      // 预热编译（仅 dev 模式需要）：dev server 冷启动时按需编译每个路由——首个
      // 浏览器用例曾把整笔编译成本（/edit 页 ~17s、templates/reports 等 API 各
      // ~12s，受 run-e2e 的 CPU 配额约束）烧进 30s 的用例预算里，generation-
      // sessions 请求还没回来就被超时杀掉。这里在 worker fixture（预算独立于
      // 用例）里把重路由编译一遍。GET 打在只有 POST 的路由上返回 405、带无效
      // id 的请求返回 400/404——但路由模块照常完成编译，预热目的已达到，故
      // .catch() 静默（预热失败留给用例自身去报）。
      if (nextServerMode === 'development') {
        const warmUpPaths = [
          '/edit/0',
          '/api/templates',
          '/api/prompts/styles',
          '/api/events',
          '/api/reports',
          '/api/reports/0',
          '/api/reports/0/generation-sessions?variant=personal',
          '/api/reports/0/generation-sessions/0/turns',
          '/api/reports/0/generation-sessions/0/proposals/0/accept',
        ]
        await Promise.all(warmUpPaths.map((warmUpPath) =>
          fetch(`${url}${warmUpPath}`, { signal: AbortSignal.timeout(120_000) }).catch(() => undefined)
        ))
      }
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
  }, { scope: 'worker', timeout: process.env.CI ? 300_000 : 240_000 }],
  baseURL: async ({ appURL }, use) => { await use(appURL) },
})

export { expect }
