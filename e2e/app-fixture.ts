/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture callbacks are not React hooks. */
import { expect, test as base } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { wrBin } from './go-server'

type WorkerFixtures = { appURL: string }

function runWr(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(wrBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(output)
      else reject(new Error(`wr ${args.join(' ')} failed (${signal ?? code ?? 'unknown'}):\n${output}`))
    })
  })
}

/** Runs the generation acceptance seam in a worker-owned wr process and SQLite database. */
export const test = base.extend<Record<never, never>, WorkerFixtures>({
  appURL: [async ({}, use, workerInfo) => {
    const root = await mkdtemp(path.join(process.cwd(), `.e2e-worker-${process.pid}-${workerInfo.workerIndex}-`))
    const port = 3200 + workerInfo.workerIndex
    const env = {
      ...process.env,
      E2E_FIXTURES: '1',
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      WR_AUTH_DISABLED: '1',
    }
    if (!existsSync(wrBin)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`${wrBin} not found — run \`make build\` first (the suite's main webServer does this automatically)`)
    }
    let child!: ChildProcess
    let logs = ''
    // 与 Next 时代的 worker 不同：单二进制不需要拷贝应用树/预构建，
    // 只需在同一个 XDG 根上先显式迁移（serve 对空库 fail closed），
    // 再起 serve。任一步失败都要回收临时目录，否则仓库里留下
    // `.e2e-worker-*` 残骸。
    try {
      await runWr(['db', 'migrate'], env)
      child = spawn(wrBin, ['serve'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      child.stdout?.on('data', (chunk) => { logs += chunk.toString() })
      child.stderr?.on('data', (chunk) => { logs += chunk.toString() })
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const url = `http://127.0.0.1:${port}`
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(logs)
        return fetch(`${url}/api/settings/ai`).then((response) => response.status === 200).catch(() => false)
      }, { timeout: 90_000, message: 'wr worker app did not become ready' }).toBeTruthy()
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
