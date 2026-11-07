import { expect, test } from '@playwright/test'
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { applyDatabaseMigrations } from '../src/lib/db/migrations'
import { wrBin } from './go-server'
import { startScriptedAI } from './scripted-ai'

async function startLegacyApplication() {
  // 与 e2e/app-fixture.ts 一致把临时根放在仓库内（.gitignore 的
  // .e2e-worker-* 规则覆盖）。单二进制无应用树拷贝，目录里只有
  // XDG 数据根与预置迁移语料。
  const root = await mkdtemp(path.join(process.cwd(), `.e2e-worker-legacy-${process.pid}-`))
  let provider: Awaited<ReturnType<typeof startScriptedAI>> | undefined
  let child: ChildProcess | undefined
  try {
    provider = await startScriptedAI()
    const dataHome = path.join(root, 'data')
    const migrations = path.join(root, 'pre-31-migrations')
    await mkdir(path.join(dataHome, 'weekly-reporter'), { recursive: true })
    await cp(path.resolve('drizzle'), migrations, { recursive: true })
    await unlink(path.join(migrations, '0032_legacy_direct_edit_compatibility.sql'))
    const journalPath = path.join(migrations, 'meta', '_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    // 保留 0032 之前的 journal 条目（即 0000–0031），让启动时重新应用 0032 及后续迁移。
    journal.entries = journal.entries.filter((e) => e.tag < '0032_legacy_direct_edit_compatibility')
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)

    const sqlite = new Database(path.join(dataHome, 'weekly-reporter', 'reports.db'))
    applyDatabaseMigrations(sqlite, migrations)
    sqlite.prepare(`INSERT INTO reports (
      title, content, week_start, week_end, created_at, updated_at, score_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('Pre-migration legacy report', 'Original legacy final', '2026-08-10', '2026-08-16', Date.now(), Date.now(), 'completed')
    sqlite.prepare(`INSERT INTO ai_config (
      protocol, api_url, api_key, model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('openai-compatible', provider.url, 'test-key', 'e2e-scripted', Date.now(), Date.now())
    sqlite.prepare(`INSERT INTO ai_styles (
      key, label, system_prompt, temperature, score_structure_weight,
      score_content_weight, score_value_weight, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('formal', 'Formal', '', '0.3', 25, 30, 45, 1, Date.now(), Date.now())
    sqlite.close()

    // 单二进制不需要拷贝应用树/预构建：在同一个 XDG 根上先显式迁移
    // （serve 对账本校验 fail closed；`wr db migrate` 在 31/41 的 legacy
    // 账本上补应用 0032 及后续——这正是本 spec 要验的迁移路径），再起 serve。
    const legacyEnv = {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      PORT: '3391',
      HOSTNAME: '127.0.0.1',
      E2E_FIXTURES: '1',
      // 此 spec 只关心数据迁移正确性，与认证改造无关——关掉认证。
      WR_AUTH_DISABLED: '1',
    }
    await new Promise<void>((resolve, reject) => {
      const migrate = spawn(wrBin, ['db', 'migrate'], {
        env: legacyEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let migrateLogs = ''
      migrate.stdout.on('data', (chunk) => { migrateLogs += chunk.toString() })
      migrate.stderr.on('data', (chunk) => { migrateLogs += chunk.toString() })
      migrate.once('error', reject)
      migrate.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`wr db migrate failed on the legacy fixture (${signal ?? code ?? 'unknown'}):\n${migrateLogs}`))
      })
    })
    child = spawn(wrBin, ['serve'], {
      env: legacyEnv,
      detached: true,
      stdio: 'ignore',
    })
    const url = 'http://127.0.0.1:3391'
    await expect.poll(async () => fetch(`${url}/api/reports/1`).then((response) => response.ok).catch(() => false), { timeout: 90_000 }).toBe(true)
    return { root, child, provider, url }
  } catch (error) {
    // 搭建失败（构建错、就绪超时、拷贝错）时回收本函数申请的临时目录与 scripted
    // AI provider——两者都不归用例的 finally 管，否则仓库里会留下
    // `.e2e-worker-legacy-*` 残骸。就绪 poll 超时但 server 挂起时还会留下一个
    // detached 子进程占住 3391 端口，让后续用例连锁失败，故先杀进程组。
    // 回收自身的失败不能盖掉原始异常。
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* The server already exited. */ }
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    await provider?.close().catch(() => undefined)
    throw error
  }
}

test('启动预置旧版本数据库时保留 legacy 终版且不伪造会话或快照', async ({ request }) => {
  // 单二进制下本用例的前置只有一次 `wr db migrate`（秒级），默认 30s 预算足够。
  const app = await startLegacyApplication()
  try {
    const opened = await request.get(`${app.url}/api/reports/1`)
    expect(opened.ok()).toBe(true)
    const legacy = await opened.json() as { variants: Array<{ sourceRevision: number; finalContent: string }> }
    expect(legacy.variants).toEqual([expect.objectContaining({ sourceRevision: 0, finalContent: 'Original legacy final' })])

    const saved = await request.put(`${app.url}/api/reports/1/final`, {
      data: { variant: 'personal', content: 'Edited legacy final' },
    })
    expect(saved.ok()).toBe(true)

    await expect.poll(async () => {
      const response = await request.get(`${app.url}/api/reports/1`)
      return (await response.json() as { content: string }).content
    }).toBe('Edited legacy final')

    const database = new Database(path.join(app.root, 'data', 'weekly-reporter', 'reports.db'), { readonly: true })
    expect(database.prepare('SELECT COUNT(*) AS count FROM report_variants').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM report_event_snapshots').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM generation_sessions').get()).toEqual({ count: 0 })
    database.close()
  } finally {
    if (app.child.pid) process.kill(-app.child.pid, 'SIGKILL')
    await app.provider.close()
    await rm(app.root, { recursive: true, force: true })
  }
})
