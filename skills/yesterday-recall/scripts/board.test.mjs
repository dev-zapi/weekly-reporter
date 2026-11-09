// Integration tests for board.mjs, written for the repo's vitest setup.
// Run: npm test -- skills/yesterday-recall/scripts/board.test.mjs
//
// Seams under test (public boundaries only):
//   1. child process CLI + stdout contract (LISTENING / ANSWERS_FILE)
//   2. HTTP GET / (rendered page structure)
//   3. HTTP POST /submit (answers file JSON contract, one-shot 409)
//   4. port selection on bind conflict
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const BOARD = path.join(SCRIPT_DIR, 'board.mjs')
const TEST_TIMEOUT = 15_000

async function makeTmpDir() {
  return mkdtemp(path.join(os.tmpdir(), 'yesterday-recall-'))
}

function spawnBoard({ mode, inputPath, answersPath, port = 0, questionsFlag = false }) {
  const args = [BOARD, `--${mode}`]
  if (questionsFlag) args.push('--questions', inputPath)
  else args.push(inputPath)
  args.push('--answers', answersPath)
  if (port !== null) args.push('--port', String(port))
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for LISTENING\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 8000)
    child.stdout.on('data', () => {
      const match = stdout.match(/LISTENING http:\/\/127\.0\.0\.1:(\d+)\//)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`board exited (${code}) before listening\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })

  return {
    child,
    listening,
    stdout: () => stdout,
    stderr: () => stderr,
    answersPath,
  }
}

async function withBoard({ mode, input, port = 0, questionsFlag = false, fn }) {
  const dir = await makeTmpDir()
  const inputPath = path.join(dir, 'input.json')
  const answersPath = path.join(dir, 'answers.json')
  await writeFile(inputPath, JSON.stringify(input, null, 2))

  const board = spawnBoard({ mode, inputPath, answersPath, port, questionsFlag })
  try {
    const actualPort = await board.listening
    await fn({
      ...board,
      port: actualPort,
      base: `http://127.0.0.1:${actualPort}`,
    })
  } finally {
    if (board.child.exitCode === null) board.child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
}

function waitForExit(child, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => reject(new Error('timeout waiting for process exit')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

// Runs a board invocation that is expected to exit without listening (CLI/input errors).
function runToExit(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOARD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timeout waiting for exit\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function fetchPage(base) {
  const res = await fetch(`${base}/`)
  expect(res.status).toBe(200)
  return res.text()
}

async function submit(base, payload) {
  return fetch(`${base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function readAnswers(answersPath) {
  return JSON.parse(await readFile(answersPath, 'utf8'))
}

describe('yesterday-recall board', () => {
  describe('--gaps', () => {
    it('renders 上午/下午/晚上 blocks plus 其他 and writes the blocks contract', { timeout: TEST_TIMEOUT }, async () => {
      const input = {
        date: '2026-11-06',
        anchors: [
          { time: '02:37', src: 'mem', text: '迁移 B1 收尾' },
          { time: '10:30', src: 'git', text: 'test(collect): pin JS number' },
          { time: '13:33', src: 'git', text: 'refactor(collect): hoist' },
          { time: '18:20', src: 'mem', text: '晚上复盘' },
        ],
      }

      await withBoard({
        mode: 'gaps',
        input,
        fn: async ({ base, answersPath, child, stdout }) => {
          expect(stdout()).toContain('ANSWERS_FILE ')
          expect(stdout()).toContain(answersPath)
          expect(stdout()).toMatch(/LISTENING http:\/\/127\.0\.0\.1:\d+\/ mode=gaps/)
          const html = await fetchPage(base)
          for (const needle of [
            '<h2>上午</h2>',
            '<h2>下午</h2>',
            '<h2>晚上</h2>',
            '其他',
            'data-blk="morning"',
            'data-blk="afternoon"',
            'data-blk="evening"',
            'data-blk="other"',
            '迁移 B1 收尾',
            'refactor(collect): hoist',
          ]) {
            expect(html).toContain(needle)
          }
          expect((html.match(/class="anchor /g) || []).length).toBe(4)

          const res = await submit(base, {
            blocks: {
              morning: '补充 A\n第二行',
              afternoon: '补充 B',
              other: '零碎',
            },
          })
          expect(res.status).toBe(200)

          expect(await readAnswers(answersPath)).toEqual({
            date: '2026-11-06',
            blocks: {
              morning: '补充 A\n第二行',
              afternoon: '补充 B',
              other: '零碎',
            },
          })
          expect(await waitForExit(child)).toBe(0)
        },
      })
    })

    it('zero anchors renders the whole-day open question', { timeout: TEST_TIMEOUT }, async () => {
      const input = { date: '2026-11-06', anchors: [] }

      await withBoard({
        mode: 'gaps',
        input,
        fn: async ({ base, answersPath, child }) => {
          const html = await fetchPage(base)
          expect(html).toContain('昨天一整天没有任何已记录的工作痕迹。')
          expect(html).toContain('data-blk="wholeday"')
          expect(html).toContain('placeholder="昨天……"')
          expect(html).not.toContain('<h2>上午</h2>')
          expect(html).not.toContain('data-blk="other"')

          const res = await submit(base, { blocks: { wholeday: '在家休息，顺手修了个脚本' } })
          expect(res.status).toBe(200)
          expect(await readAnswers(answersPath)).toEqual({
            date: '2026-11-06',
            blocks: { wholeday: '在家休息，顺手修了个脚本' },
          })
          expect(await waitForExit(child)).toBe(0)
        },
      })
    })

    it('groups anchors without a usable time under 其他 instead of 晚上', { timeout: TEST_TIMEOUT }, async () => {
      const input = {
        date: '2026-11-06',
        anchors: [
          { time: '', src: 'mem', text: '没有时间的记忆' },
          { time: '24:30', src: 'git', text: '越界时间' },
        ],
      }

      await withBoard({
        mode: 'gaps',
        input,
        fn: async ({ base }) => {
          const html = await fetchPage(base)
          const otherSection = html.split('<h2>其他</h2>')[1]
            ?.split('<p class="q" style="margin-top:1.5rem">')[0] ?? ''
          expect(otherSection).toContain('无时间锚点 · 2 条锚点')
          expect(otherSection).toContain('没有时间的记忆')
          expect(otherSection).toContain('越界时间')

          const eveningSection = html.split('<h2>晚上</h2>')[1]
            ?.split('<div class="blk-h"><h2>其他</h2>')[0] ?? ''
          expect(eveningSection).not.toContain('没有时间的记忆')
          expect(eveningSection).not.toContain('越界时间')
        },
      })
    })

    it('labels manual timeline anchors as 手动 and memory anchors as 记忆', { timeout: TEST_TIMEOUT }, async () => {
      const input = {
        date: '2026-11-06',
        anchors: [
          { time: '10:30', src: 'manual', text: '手动补的一条' },
          { time: '10:40', src: 'mem', text: '记忆里的一条' },
        ],
      }

      await withBoard({
        mode: 'gaps',
        input,
        fn: async ({ base }) => {
          const html = await fetchPage(base)
          expect(html).toContain('class="anchor manual"')
          expect(html).toContain('<span class="src">手动</span>')
          expect(html).toContain('<span class="src">记忆</span>')
          expect(html).not.toContain('<span class="src">提交</span>')
        },
      })
    })
  })

  describe('--confirm', () => {
    it('dual columns, read-only existing side, editable draft cards', { timeout: TEST_TIMEOUT }, async () => {
      const input = {
        date: '2026-11-06',
        existing: [
          { time: '10:30', src: 'auto', text: 'test(collect): pin JS number & branch ordering' },
          { time: '12:47', src: 'manual', text: '手动补的一条' },
        ],
        drafts: [
          { time: '09:30', text: '把迁移蓝图 #88 拆成 22 张工单 %12' },
          { time: '13:50', text: '跑 B3–B6 迁移 workflow @8891' },
          { time: '16:40', text: '<script>alert(1)</script> #迁移' },
        ],
      }

      await withBoard({
        mode: 'confirm',
        input,
        fn: async ({ base }) => {
          const html = await fetchPage(base)
          expect(html).toContain('class="col-wrap"')
          expect(html).toContain('已有事件（2 条 · 只读）')
          expect(html).toContain('新草稿（3 条 · 可改）')

          const leftColumn = html.match(/<div class="col">([\s\S]*?)<div class="col">/)?.[1] ?? ''
          expect(leftColumn.length).toBeGreaterThan(0)
          expect(leftColumn).not.toContain('<input')
          expect(leftColumn).not.toContain('<textarea')
          expect((leftColumn.match(/class="exist"/g) || []).length).toBe(2)
          expect(leftColumn).toContain('<span class="src">自动</span>')
          expect(leftColumn).toContain('<span class="src">手动</span>')

          expect((html.match(/class="draft"/g) || []).length).toBe(3)
          expect((html.match(/type="checkbox"/g) || []).length).toBe(3)
          expect((html.match(/type="time"/g) || []).length).toBe(3)
          expect((html.match(/<textarea/g) || []).length).toBe(3)
          expect(html).toContain('value="09:30"')
          expect(html).toContain('value="16:40"')
          expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
          expect(html).not.toContain('<script>alert(1)</script>')
        },
      })
    })

    it('folds whitespace in content and leaves excluded drafts out', { timeout: TEST_TIMEOUT }, async () => {
      const input = {
        date: '2026-11-06',
        existing: [],
        drafts: [
          { time: '13:50', text: '第一条草稿' },
          { time: '16:40', text: '第二条草稿（应被排除）' },
          { time: '18:20', text: '第三条草稿' },
        ],
      }

      await withBoard({
        mode: 'confirm',
        input,
        fn: async ({ base, answersPath, child }) => {
          const res = await submit(base, {
            confirmed: [
              { content: '第一行\n\n  第二行\t  %12 @8891 #迁移 ', time: '13:50' },
              { content: '另一条\n跨行', time: '9:05' },
            ],
          })
          expect(res.status).toBe(200)

          const answers = await readAnswers(answersPath)
          expect(answers).toEqual({
            date: '2026-11-06',
            confirmed: [
              { content: '第一行 第二行 %12 @8891 #迁移', time: '13:50' },
              { content: '另一条 跨行', time: '09:05' },
            ],
          })
          expect(answers.confirmed.length).toBe(2)
          expect(await waitForExit(child)).toBe(0)
        },
      })
    })

    it('falls back to the draft default time when the submitted time is unusable, then drops it', { timeout: TEST_TIMEOUT }, async () => {
      const input = {
        date: '2026-11-06',
        existing: [],
        drafts: [
          { time: '09:30', text: '保留默认时间' },
          { time: '13:50', text: '非法时间回退' },
          { time: '', text: '无可用时间应丢弃' },
        ],
      }

      await withBoard({
        mode: 'confirm',
        input,
        fn: async ({ base, answersPath, child }) => {
          const res = await submit(base, {
            confirmed: [
              { content: '保留默认时间', time: '', index: 0 },
              { content: '非法时间回退', time: '99:99', index: 1 },
              { content: '无可用时间应丢弃', time: '', index: 2 },
              { content: '没有索引也要丢弃', time: '' },
            ],
          })
          expect(res.status).toBe(200)

          const answers = await readAnswers(answersPath)
          expect(answers).toEqual({
            date: '2026-11-06',
            confirmed: [
              { content: '保留默认时间', time: '09:30' },
              { content: '非法时间回退', time: '13:50' },
            ],
          })
          expect(Object.keys(answers.confirmed[0])).toEqual(['content', 'time'])
          expect(await waitForExit(child)).toBe(0)
        },
      })
    })
  })

  describe('cli', () => {
    it('--questions provides the input JSON path', { timeout: TEST_TIMEOUT }, async () => {
      await withBoard({
        mode: 'gaps',
        input: { date: '2026-11-06', anchors: [] },
        questionsFlag: true,
        fn: async ({ base }) => {
          const html = await fetchPage(base)
          expect(html).toContain('data-blk="wholeday"')
        },
      })
    })

    it('rejects the removed --input alias', { timeout: TEST_TIMEOUT }, async () => {
      const result = await runToExit(['--gaps', '--input', 'whatever.json'])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('Unknown argument: --input')
    })

    it('--help lists every supported flag', { timeout: TEST_TIMEOUT }, async () => {
      const result = await runToExit(['--help'])
      expect(result.code).toBe(0)
      for (const flag of ['--gaps', '--confirm', '--questions', '--answers', '--port', '--help']) {
        expect(result.stdout).toContain(flag)
      }
    })

    it('rejects impossible calendar dates', { timeout: TEST_TIMEOUT }, async () => {
      for (const date of ['2026-99-99', '2026-02-30']) {
        const dir = await makeTmpDir()
        try {
          const inputPath = path.join(dir, 'input.json')
          await writeFile(inputPath, JSON.stringify({ date, anchors: [] }))
          const result = await runToExit(['--gaps', inputPath])
          expect(result.code).toBe(1)
          expect(result.stderr).toContain('valid YYYY-MM-DD date')
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
    })

    it('default port starts at 19950', { timeout: TEST_TIMEOUT }, async () => {
      await withBoard({
        mode: 'gaps',
        input: { date: '2026-11-06', anchors: [] },
        port: null,
        fn: async ({ port }) => {
          expect(port).toBeGreaterThanOrEqual(19950)
        },
      })
    })
  })

  describe('server', () => {
    it('first submission wins, the second gets 409, then the process exits', { timeout: TEST_TIMEOUT }, async () => {
      const input = { date: '2026-11-06', anchors: [] }

      await withBoard({
        mode: 'gaps',
        input,
        fn: async ({ base, answersPath, child }) => {
          const first = await submit(base, { blocks: { wholeday: '第一次提交' } })
          expect(first.status).toBe(200)
          await first.text()

          const second = await submit(base, { blocks: { wholeday: '第二次提交' } })
          expect(second.status).toBe(409)

          expect(await waitForExit(child)).toBe(0)
          expect(await readAnswers(answersPath)).toEqual({
            date: '2026-11-06',
            blocks: { wholeday: '第一次提交' },
          })
        },
      })
    })

    it('walks upward to a free port when the base port is busy and stays reachable', { timeout: TEST_TIMEOUT }, async () => {
      const blocker = net.createServer()
      await new Promise((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(0, '0.0.0.0', resolve)
      })
      const busyPort = blocker.address().port

      try {
        await withBoard({
          mode: 'gaps',
          input: { date: '2026-11-06', anchors: [] },
          port: busyPort,
          fn: async ({ port, base, child }) => {
            expect(port).toBeGreaterThan(busyPort)
            const html = await fetchPage(base)
            expect(html).toContain('data-blk="wholeday"')
            await submit(base, { blocks: { wholeday: 'ok' } })
            expect(await waitForExit(child)).toBe(0)
          },
        })
      } finally {
        await new Promise((resolve) => blocker.close(resolve))
      }
    })
  })

  describe('ratified style rules', () => {
    async function capturePage(mode, input) {
      let html = ''
      await withBoard({
        mode,
        input,
        fn: async ({ base }) => { html = await fetchPage(base) },
      })
      return html
    }

    // Design invariants shared by both pages: 16px base with rem-only sizing,
    // system font keywords, explicit form-control colors (light and dark),
    // dark adaptation, and auto-growing textareas.
    function assertRatifiedTypography(html) {
      expect(html).toMatch(/html\s*\{\s*font-size:\s*16px;?\s*\}/)
      const pxSizes = [...new Set((html.match(/\d*\.?\d+px\b/g) || []))]
      expect(pxSizes).toEqual(['16px'])

      const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
      const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim())
      expect(families.length).toBeGreaterThan(0)
      for (const family of families) expect(family).toMatch(/^(serif|monospace)$/)
      expect(families).toContain('serif')
      expect(families).toContain('monospace')

      expect(css).toMatch(/(^|\})\s*(input,\s*textarea|textarea,\s*input)\s*\{\s*color:\s*var\(--ink\)/)
      expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/)
      expect(css).toMatch(/textarea\s*\{[^}]*resize:\s*none;[^}]*overflow:\s*hidden;/s)
      expect(html).toContain('scrollHeight')
    }

    it('gaps page carries ratified typography, dark mode and auto-grow rules', { timeout: TEST_TIMEOUT }, async () => {
      const html = await capturePage('gaps', {
        date: '2026-11-06',
        anchors: [{ time: '10:30', src: 'git', text: 'pin JS number semantics' }],
      })
      assertRatifiedTypography(html)
      expect(html).toContain('--warn:')
    })

    it('gaps empty state keeps the same design invariants and empty-state copy', { timeout: TEST_TIMEOUT }, async () => {
      const html = await capturePage('gaps', { date: '2026-11-06', anchors: [] })
      expect(html).toContain('昨天一整天没有任何已记录的工作痕迹。')
      assertRatifiedTypography(html)
    })

    it('confirm page carries ratified typography and a two-column layout', { timeout: TEST_TIMEOUT }, async () => {
      const html = await capturePage('confirm', {
        date: '2026-11-06',
        existing: [{ time: '10:30', src: 'auto', text: 'existing' }],
        drafts: [{ time: '13:50', text: 'draft' }],
      })
      assertRatifiedTypography(html)
      expect(html).toContain('class="col-wrap"')
      expect((html.match(/class="col"/g) || []).length).toBe(2)
      expect(html).toContain('type="time"')
      expect(html).toContain('class="draft-time"')
    })
  })
})
