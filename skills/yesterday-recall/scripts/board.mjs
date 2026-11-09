#!/usr/bin/env node
// yesterday-recall one-shot interaction board.
//
// Usage:
//   node board.mjs --gaps|--confirm <input.json> [--answers <path>] [--port <base>]
//   node board.mjs --gaps|--confirm --questions <input.json> [--answers <path>] [--port <base>]
//
// --gaps input:
//   { "date": "YYYY-MM-DD",
//     "anchors": [ { "time": "HH:MM", "src": "git" | "manual" | "mem", "text": "…" } ] }
//   Anchors whose time cannot be parsed are grouped under 其他 instead of 晚上.
//
// --confirm input:
//   { "date": "YYYY-MM-DD",
//     "existing": [ { "time": "HH:MM", "src": "auto" | "manual", "text": "…" } ],
//     "drafts":   [ { "time": "HH:MM", "text": "…" } ] }
//
// Serves exactly one page, accepts exactly one submission, writes a JSON answers
// file, then exits. Binds 0.0.0.0 without auth: trusted LAN only, and the input
// must never carry secrets. Ports are picked upward from 19950 on bind conflicts.
import http from 'node:http'
import os from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_PORT = 19950
const MAX_BODY_BYTES = 1_000_000
const BLOCKS = [
  { key: 'morning', name: '上午', range: '00:00–12:00' },
  { key: 'afternoon', name: '下午', range: '12:00–18:00' },
  { key: 'evening', name: '晚上', range: '18:00–24:00' },
]

function fail(message, code = 2) {
  console.error(message)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let mode = ''
  let inputPath = ''
  let answersPath = ''
  let port = DEFAULT_PORT

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--gaps' || arg === '--confirm') {
      mode = arg.slice(2)
    } else if (arg === '--questions') {
      inputPath = argv[++i]
      if (!inputPath) fail(`Error: ${arg} requires an input JSON path`)
    } else if (arg === '--answers') {
      answersPath = argv[++i]
      if (!answersPath) fail('Error: --answers requires a path')
    } else if (arg === '--port') {
      const raw = argv[++i]
      if (raw === undefined) fail('Error: --port requires a number')
      port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        fail(`Error: invalid port: ${raw}`)
      }
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage:')
      console.log('  node board.mjs --gaps|--confirm <input.json> [--answers <path>] [--port <base>]')
      console.log('  node board.mjs --gaps|--confirm --questions <input.json> [--answers <path>] [--port <base>]')
      console.log('')
      console.log('Flags:')
      console.log('  --gaps | --confirm   page mode (required; one of the two)')
      console.log('  --questions <path>   input JSON path (same as the positional argument)')
      console.log('  --answers <path>     answers output path (default: <input>.answers.json)')
      console.log('  --port <base>        first port to try (default 19950; walks upward on conflicts)')
      console.log('  -h, --help           show this help')
      console.log('')
      console.log('Serves one board page on 0.0.0.0, writes the first submission to the')
      console.log('answers file, then exits.')
      process.exit(0)
    } else if (arg.startsWith('-')) {
      fail(`Unknown argument: ${arg}`)
    } else if (!inputPath) {
      inputPath = arg
    } else {
      fail(`Unexpected argument: ${arg}`)
    }
  }

  if (!mode || !inputPath) fail('Error: one of --gaps / --confirm <input.json> is required')
  if (!answersPath) {
    answersPath = inputPath.endsWith('.json')
      ? inputPath.slice(0, -'.json'.length) + '.answers.json'
      : inputPath + '.answers.json'
  }
  return { mode, inputPath, answersPath, port }
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  // Round-trip through the real calendar so 2026-02-30 / 2026-99-99 do not pass.
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function readInput(inputPath) {
  let input
  try {
    input = JSON.parse(readFileSync(inputPath, 'utf8'))
  } catch (err) {
    fail(`Error: failed to read input JSON (${inputPath}): ${err.message}`, 1)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Error: input JSON must be an object', 1)
  }
  if (!isValidDate(input.date)) {
    fail('Error: input JSON must have a valid YYYY-MM-DD date', 1)
  }
  return input
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const day = new Date(y, m - 1, d, 12).getDay()
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day]
}

function dateTitle(dateStr) {
  return `${dateStr}（${weekday(dateStr)}）`
}

function hourOf(time) {
  const hour = Number.parseInt(String(time ?? ''), 10)
  return Number.isInteger(hour) ? hour : NaN
}

function blockKeyOf(time) {
  const hour = hourOf(time)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 'other'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

const SOURCE_LABELS = { git: '提交', manual: '手动', mem: '记忆', auto: '自动' }

function sourceOf(anchor) {
  if (anchor.src === 'mem' || anchor.src === 'manual') return anchor.src
  return 'git'
}

function normalizeAnchors(input) {
  const raw = Array.isArray(input.anchors) ? input.anchors : []
  return raw
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      time: String(a.time ?? ''),
      src: sourceOf(a),
      text: String(a.text ?? ''),
    }))
    .filter((a) => a.time || a.text)
}

function anchorRow(anchor) {
  return `<div class="anchor ${anchor.src}"><span class="t">${esc(anchor.time)}</span>`
    + `<span class="src">${SOURCE_LABELS[anchor.src] ?? '提交'}</span>`
    + `<span>${esc(anchor.text)}</span></div>`
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const BASE_CSS = `
  * { box-sizing: border-box; }
  html { font-size: 16px; }
  body { margin: 0; font-family: serif; font-size: 1.0625rem; line-height: 1.65; }
  .mono, .anchor, .exist, .draft, textarea, input { font-family: monospace; }
`

// Shared page chrome: tokens, prose/layout, buttons, form-control colors, dark mode.
const THEME_CSS = `
  :root {
    color-scheme: light dark;
    --ink: #1f2328; --muted: #57606a; --line: #d8dee4; --bg: #f6f8fa;
    --accent: #0969da; --accent-soft: #ddf4ff; --warn: #9a6700;
  }
  body { color: var(--ink); background: #fff; }
  input, textarea { color: var(--ink); }
  input::placeholder, textarea::placeholder { color: var(--muted); }
  .doc { max-width: 54rem; margin: 0 auto; padding: 1.5rem 1.25rem 8rem; }
  h1 { font-size: 1.45rem; margin: 0 0 0.1rem; }
  .sub { color: var(--muted); font-size: 0.875rem; margin-bottom: 1.25rem; }
  .hint { color: var(--muted); font-size: 0.875rem; }
  .submit-row { margin-top: 1.6rem; display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  button.primary { background: var(--accent); color: #fff; border: 0; border-radius: 0.5rem; padding: 0.55rem 1.4rem; font-size: 1.05rem; font-family: serif; cursor: pointer; }
  button.primary:disabled { opacity: 0.65; cursor: wait; }
  .count-pill { color: var(--muted); font-size: 0.875rem; }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #15181d;
      --accent: #4493f8; --accent-soft: #122d42; --warn: #d29922;
    }
    body { background: #0d1117; }
    input, textarea { color: var(--ink); }
  }
`

// Shared client helpers: auto-growing textareas and the post-submit success swap.
const CLIENT_BASE_SCRIPT = `
const el = (id) => document.getElementById(id);
function fit(t) {
  t.style.height = 'auto';
  const cs = getComputedStyle(t);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  t.style.height = (t.scrollHeight + border) + 'px';
}
document.addEventListener('input', (e) => { if (e.target.matches('textarea')) fit(e.target); });
document.querySelectorAll('textarea').forEach(fit);
function showSuccess(title) {
  const app = el('app');
  app.replaceChildren();
  const h1 = document.createElement('h1');
  h1.textContent = title;
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = '本轮结束，可以关闭本页。';
  app.append(h1, p);
}
`

const GAPS_CSS = `
  .blk-h { display: flex; align-items: baseline; gap: 0.6rem; margin: 1.6rem 0 0.5rem; }
  .blk-h h2 { font-size: 1.2rem; margin: 0; }
  .blk-h .range { color: var(--muted); font-size: 0.875rem; }
  .anchor { display: flex; gap: 0.5rem; align-items: baseline; padding: 0.15rem 0 0.15rem 0.85rem; border-left: 0.125rem solid var(--line); margin-left: 0.25rem; font-size: 0.9rem; color: var(--muted); }
  .anchor .t { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .anchor .src { font-size: 0.78rem; border: 0.0625rem solid var(--line); border-radius: 0.25rem; padding: 0 0.25rem; color: var(--muted); white-space: nowrap; }
  .anchor.mem { border-left-color: #bf8700; }
  .anchor.git { border-left-color: var(--accent); }
  .anchor.manual { border-left-color: var(--warn); }
  textarea { width: 100%; padding: 0.5rem 0.6rem; font-size: 0.95rem; line-height: 1.6; border: 0.0625rem solid var(--line); border-radius: 0.5rem; background: var(--bg); resize: none; overflow: hidden; min-height: 2.6rem; }
  textarea:focus { outline: 0.125rem solid var(--accent-soft); border-color: var(--accent); background: #fff; }
  .q { font-size: 1.05rem; margin: 0.4rem 0 0.25rem; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    textarea:focus { background: #0d1117; }
  }
`

const CONFIRM_CSS = `
  textarea { resize: none; overflow: hidden; min-height: 2.2rem; line-height: 1.55; }
  .draft textarea { width: 100%; font-size: 0.95rem; padding: 0.35rem 0.5rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: #fff; display: block; }
  .col-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4rem; }
  @media (max-width: 45rem) { .col-wrap { grid-template-columns: 1fr; } }
  .col h3 { font-size: 0.95rem; margin: 0 0 0.5rem; color: var(--muted); font-weight: 600; }
  .exist { border: 0.0625rem solid var(--line); border-radius: 0.5rem; padding: 0.3rem 0.6rem; margin-bottom: 0.35rem; font-size: 0.9rem; display: flex; gap: 0.5rem; align-items: baseline; }
  .exist .t { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
  .exist .src { font-size: 0.75rem; border-radius: 0.25rem; padding: 0 0.25rem; border: 0.0625rem solid var(--line); color: var(--muted); }
  .draft { border: 0.09375rem solid var(--accent); border-radius: 0.6rem; padding: 0.6rem 0.75rem; margin-bottom: 0.6rem; background: #fbfdff; }
  .draft.off { border-color: var(--line); background: var(--bg); opacity: 0.6; }
  .draft-top { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.35rem; }
  .draft-top input[type=checkbox] { width: 1rem; height: 1rem; }
  .draft-top .lbl { font-size: 0.9rem; font-weight: 600; color: var(--muted); }
  .draft-time { font-size: 0.95rem; padding: 0.15rem 0.3rem; color: var(--ink); background: transparent; border: 0.0625rem solid transparent; border-bottom: 0.0625rem dashed var(--line); border-radius: 0.25rem; }
  .draft-time:hover { border-bottom-color: var(--accent); }
  .draft-time:focus { outline: 0.125rem solid var(--accent-soft); border-color: var(--accent); background: #fff; }
  @media (prefers-color-scheme: dark) {
    .draft { background: #10161f; }
    .draft textarea, .draft-time:focus, textarea:focus { background: #0d1117; }
    .draft-time { color: var(--ink); }
    input[type=time] { background-color: transparent; }
  }
`

function pageShell(title, style, body, script) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${style}</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>`
}

function renderGapsPage(input) {
  const anchors = normalizeAnchors(input)
  const grouped = { morning: [], afternoon: [], evening: [], other: [] }
  for (const anchor of anchors) grouped[blockKeyOf(anchor.time)].push(anchor)

  let content = `
    <h1>昨日回忆 · ${esc(dateTitle(input.date))}</h1>
    <div class="sub">--gaps 收集页 · 时间轴分组</div>`

  if (anchors.length === 0) {
    content += `<div style="border:0.09375rem solid var(--warn);border-radius:0.6rem;padding:1rem 1.2rem">
      <div class="q">昨天一整天没有任何已记录的工作痕迹。</div>
      <p class="hint" style="margin:0.25rem 0 0.75rem">可能是休息日，也可能是采集没跑。从早到晚想一遍，写下还记得的：</p>
      <textarea data-blk="wholeday" placeholder="昨天……"></textarea></div>`
  } else {
    for (const block of BLOCKS) {
      const rows = grouped[block.key]
      content += `<div class="blk-h"><h2>${block.name}</h2>`
        + `<span class="range">${block.range} · ${rows.length} 条锚点</span></div>`
      content += rows.length
        ? rows.map(anchorRow).join('')
        : '<div class="hint" style="padding-left:1.1rem">（无锚点）</div>'
      content += `<p class="q">${block.name}这段时间还有什么没记录的？</p>
        <textarea data-blk="${block.key}" placeholder="例：上午还在跟 XX 对了口径，改了两版文档……"></textarea>`
    }

    if (grouped.other.length) {
      content += `<div class="blk-h"><h2>其他</h2>`
        + `<span class="range">无时间锚点 · ${grouped.other.length} 条锚点</span></div>`
      content += grouped.other.map(anchorRow).join('')
    }

    content += `<p class="q" style="margin-top:1.5rem">其他 <span class="hint">（不属于上面任何时段的）</span></p>
      <textarea data-blk="other" placeholder="零碎的、跨时段的、忽然想起来的……"></textarea>`
  }

  content += `<div class="submit-row"><button class="primary" id="submit">提交回忆</button>
    <span class="count-pill">提交后由 Claude 蒸馏成一行式事件草稿 → 进入确认页</span></div>`

  const script = `${CLIENT_BASE_SCRIPT}
el('submit').addEventListener('click', async () => {
  const out = { blocks: {} };
  document.querySelectorAll('textarea[data-blk]').forEach((t) => {
    if (t.value.trim()) out.blocks[t.dataset.blk] = t.value;
  });
  el('submit').disabled = true;
  let res;
  try {
    res = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    });
  } catch {
    el('submit').disabled = false;
    alert('提交失败：无法连接服务');
    return;
  }
  if (!res.ok) {
    el('submit').disabled = false;
    alert('提交失败：HTTP ' + res.status);
    return;
  }
  showSuccess('已收到回忆');
});`
  return pageShell(
    `昨日回忆 · ${input.date}`,
    `${BASE_CSS}${THEME_CSS}${GAPS_CSS}`,
    `<div class="doc" id="app">${content}</div>`,
    script,
  )
}

function normalizeExisting(input) {
  return Array.isArray(input.existing) ? input.existing
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      time: String(e.time ?? ''),
      src: e.src === 'manual' ? 'manual' : 'auto',
      text: String(e.text ?? ''),
    })) : []
}

function normalizeDrafts(input) {
  return Array.isArray(input.drafts) ? input.drafts
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({
      time: normalizeTime(d.time ?? ''),
      text: String(d.text ?? ''),
    })) : []
}

function renderConfirmPage(input) {
  const existing = normalizeExisting(input)
  const drafts = normalizeDrafts(input)

  const existingHtml = existing.map((e) => `<div class="exist">`
    + `<span class="t">${esc(e.time)}</span><span class="src">${SOURCE_LABELS[e.src] ?? '自动'}</span>`
    + `<span>${esc(e.text)}</span></div>`).join('')

  const draftHtml = drafts.map((d, index) => `<div class="draft" data-index="${index}">
      <div class="draft-top"><input type="checkbox" checked>
        <input type="time" value="${esc(d.time)}" class="draft-time">
        <span class="lbl">草稿</span></div>
      <textarea rows="1">${esc(d.text)}</textarea>
    </div>`).join('')

  const content = `
    <h1>昨日草稿清单 · ${esc(dateTitle(input.date))}</h1>
    <div class="sub">--confirm 确认页 · 已有事件不可改，草稿逐条裁决</div>
    <div class="hint" style="margin:-0.9rem 0 1.2rem">勾选＝纳入；时间行内点一下就改；内容多行自适应。%/@ 引用与 #tag 空格隔开，换行提交时折成空格。</div>
    <div class="col-wrap">
      <div class="col"><h3>已有事件（${existing.length} 条 · 只读）</h3>${existingHtml}</div>
      <div class="col"><h3>新草稿（${drafts.length} 条 · 可改）</h3>${draftHtml}</div>
    </div>
    <div class="submit-row"><button class="primary" id="submit">确认落库</button>
      <span class="count-pill">勾选＝纳入；排除的草稿不会出现在结果里</span></div>`

  const script = `${CLIENT_BASE_SCRIPT}
document.querySelectorAll('.draft input[type=checkbox]').forEach((cb) => {
  cb.addEventListener('change', () => cb.closest('.draft').classList.toggle('off', !cb.checked));
});
el('submit').addEventListener('click', async () => {
  const confirmed = [];
  document.querySelectorAll('.draft').forEach((card) => {
    if (!card.querySelector('input[type=checkbox]').checked) return;
    const content = card.querySelector('textarea').value.replace(/\\s+/g, ' ').trim();
    const time = card.querySelector('input[type=time]').value;
    const index = Number(card.dataset.index);
    confirmed.push({ content, time, index });
  });
  el('submit').disabled = true;
  let res;
  try {
    res = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed }),
    });
  } catch {
    el('submit').disabled = false;
    alert('提交失败：无法连接服务');
    return;
  }
  if (!res.ok) {
    el('submit').disabled = false;
    alert('提交失败：HTTP ' + res.status);
    return;
  }
  showSuccess('已收到确认');
});`

  return pageShell(
    `昨日草稿清单 · ${input.date}`,
    `${BASE_CSS}${THEME_CSS}${CONFIRM_CSS}`,
    `<div class="doc" id="app">${content}</div>`,
    script,
  )
}

// ---------------------------------------------------------------------------
// Submission normalization (server is the contract boundary)
// ---------------------------------------------------------------------------

const GAP_BLOCK_KEYS = new Set(['morning', 'afternoon', 'evening', 'other', 'wholeday'])

function normalizeGapsAnswers(input, payload) {
  const blocks = {}
  const posted = payload && typeof payload === 'object' ? payload.blocks : undefined
  if (posted && typeof posted === 'object' && !Array.isArray(posted)) {
    for (const key of GAP_BLOCK_KEYS) {
      const value = posted[key]
      if (typeof value === 'string' && value.trim()) blocks[key] = value
    }
  }
  return { date: input.date, blocks }
}

function foldWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

// Returns '' for an unusable time so callers can fall back or discard.
function normalizeTime(value) {
  const raw = String(value ?? '').trim()
  const match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ''
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return ''
  return `${String(hours).padStart(2, '0')}:${match[2]}`
}

function normalizeConfirmAnswers(input, payload) {
  const drafts = normalizeDrafts(input)
  const confirmed = []
  const posted = payload && typeof payload === 'object' && Array.isArray(payload.confirmed)
    ? payload.confirmed
    : []
  for (const item of posted) {
    if (!item || typeof item !== 'object') continue
    const content = foldWhitespace(item.content)
    if (!content) continue
    let time = normalizeTime(item.time)
    if (!time) {
      // Fall back to the selected draft's original time; drop the entry if that
      // is unusable too, so a confirm page can never produce an invalid --time.
      const index = Number(item.index)
      const draft = Number.isInteger(index) && index >= 0 && index < drafts.length
        ? drafts[index]
        : null
      time = normalizeTime(draft?.time)
    }
    if (!time) continue
    confirmed.push({ content, time })
  }
  return { date: input.date, confirmed }
}

const MODES = {
  gaps: { render: renderGapsPage, normalize: normalizeGapsAnswers },
  confirm: { render: renderConfirmPage, normalize: normalizeConfirmAnswers },
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const { mode, inputPath, answersPath, port: basePort } = parseArgs(process.argv.slice(2))
const input = readInput(inputPath)
const handlers = MODES[mode]

const SUCCESS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>已提交</title></head>
<body><p>已收到，本轮结束，可以关闭本页。</p></body></html>`

let submissionInProgress = false
let submitted = false

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    let page
    try {
      page = handlers.render(input)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(String(err.message))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }

  if (req.method === 'POST' && req.url === '/submit') {
    if (submissionInProgress || submitted) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('submission already received')
      return
    }
    submissionInProgress = true
    let body = ''
    let rejected = false
    req.on('aborted', () => {
      if (!submitted) submissionInProgress = false
    })
    req.on('data', (chunk) => {
      if (rejected) return
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        rejected = true
        submissionInProgress = false
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('payload too large')
        req.destroy()
      }
    })
    req.on('end', () => {
      if (rejected) return
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        submissionInProgress = false
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bad json')
        return
      }
      const answers = handlers.normalize(input, payload)
      try {
        writeFileSync(answersPath, JSON.stringify(answers, null, 2) + '\n')
      } catch {
        submissionInProgress = false
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('failed to write answers')
        return
      }
      submitted = true
      console.log(`ANSWERS_RECEIVED mode=${mode}`)
      console.log(JSON.stringify(answers, null, 2))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(SUCCESS_PAGE, () => setTimeout(() => process.exit(0), 200))
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

function listenFrom(startPort) {
  let attemptPort = startPort
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attemptPort < 65535) {
        attemptPort += 1
        server.listen(attemptPort, '0.0.0.0')
        return
      }
      reject(err)
    }
    server.on('error', onError)
    server.once('listening', () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    })
    server.listen(attemptPort, '0.0.0.0')
  })
}

listenFrom(basePort).then((actualPort) => {
  console.log(`ANSWERS_FILE ${answersPath}`)
  console.log(`LISTENING http://127.0.0.1:${actualPort}/ mode=${mode}`)
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((info) => info && info.family === 'IPv4' && !info.internal)
    .map((info) => info.address)
  lan.forEach((ip) => console.log(`LISTENING http://${ip}:${actualPort}/`))

  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`)
    process.exit(1)
  })
}).catch((err) => {
  console.error(`Server error: ${err.message}`)
  process.exit(1)
})
