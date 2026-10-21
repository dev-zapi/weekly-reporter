import { expect, test } from '@playwright/test'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { applyDatabaseMigrations } from '../src/lib/db/migrations'
import { nextServeArgs } from './next-server'
import { startScriptedAI } from './scripted-ai'

async function startLegacyApplication() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weekly-reporter-legacy-'))
  const app = path.join(root, 'app')
  const dataHome = path.join(root, 'data')
  const migrations = path.join(root, 'pre-31-migrations')
  const provider = await startScriptedAI()
  await mkdir(app)
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

  for (const file of ['src', 'public', 'drizzle', 'package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs']) {
    await cp(path.resolve(file), path.join(app, file), { recursive: true })
  }
  await symlink(path.resolve('node_modules'), path.join(app, 'node_modules'), 'dir')
  const port = 3391
  const child = spawn(process.execPath, nextServeArgs(port), {
    cwd: app,
    env: {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      NEXT_TELEMETRY_DISABLED: '1',
      // 此 spec 只关心数据迁移正确性，与认证改造无关——关掉认证。
      WR_AUTH_DISABLED: '1',
    },
    detached: true,
    stdio: 'ignore',
  })
  const url = `http://127.0.0.1:${port}`
  await expect.poll(async () => fetch(`${url}/api/reports/1`).then((response) => response.ok).catch(() => false), { timeout: 90_000 }).toBe(true)
  return { root, child, provider, url }
}

test('启动预置旧版本数据库时保留 legacy 终版且不伪造会话或快照', async ({ request }) => {
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
