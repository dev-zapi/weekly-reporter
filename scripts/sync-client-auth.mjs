// Stamp the shared auth block into the vendored skill clients.
//
// The skills that ship a `scripts/lib/client.mjs` each carry their own copy of
// the auth plumbing (credential resolution, self-report headers, 401 guidance).
// Skills install individually and must stay self-contained, so the copies
// cannot be replaced by a shared import - but 8 copies of the same logic
// inevitably drift.
//
// This script is the single source of truth: the block lives in
// scripts/templates/client-auth-block.template.mjs and is stamped into every
// client between the AUTH-BLOCK markers. Each copy gets its own SKILL_NAME.
//
//   node scripts/sync-client-auth.mjs           # rewrite the clients
//   node scripts/sync-client-auth.mjs --check   # fail if any client drifted
//
// Zero dependencies, Node 18+.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_PATH = join(ROOT, 'scripts', 'templates', 'client-auth-block.template.mjs')

export const BEGIN_MARKER = '// >>> AUTH-BLOCK:BEGIN'
export const END_MARKER = '// <<< AUTH-BLOCK:END'
const SKILL_NAME_PLACEHOLDER = '__SKILL_NAME__'

/** The skills that own a vendored client, in the order they are checked. */
export const CLIENTS = [
  { skill: 'collect-git-source', path: 'skills/collect-git-source/scripts/lib/client.mjs' },
  { skill: 'collect-sources', path: 'skills/collect-sources/scripts/lib/client.mjs' },
  { skill: 'period-plans', path: 'skills/period-plans/scripts/lib/client.mjs' },
  { skill: 'report-templates', path: 'skills/report-templates/scripts/lib/client.mjs' },
  { skill: 'timeline-events', path: 'skills/timeline-events/scripts/lib/client.mjs' },
  { skill: 'timeline-tags', path: 'skills/timeline-tags/scripts/lib/client.mjs' },
  { skill: 'weekly-reports', path: 'skills/weekly-reports/scripts/lib/client.mjs' },
  { skill: 'write-weekly-report', path: 'skills/write-weekly-report/scripts/lib/client.mjs' },
]

/**
 * Extract the marked block from a source file.
 * Returns null when the markers are missing or unpaired.
 */
export function extractBlock(content) {
  const begin = content.indexOf(BEGIN_MARKER)
  if (begin === -1) return null
  const end = content.indexOf(END_MARKER, begin)
  if (end === -1) return null
  return content.slice(begin, end + END_MARKER.length)
}

/**
 * The body of the marked block - the same region without the marker lines.
 * Returns null when the markers are missing or unpaired.
 */
export function extractBlockBody(content) {
  const block = extractBlock(content)
  if (block === null) return null
  const bodyStart = block.indexOf('\n')
  const bodyEnd = block.lastIndexOf('\n')
  return block.slice(bodyStart + 1, bodyEnd)
}

/** Render the template block body for one skill. */
export function renderBlock(templateBody, skill) {
  return templateBody.replaceAll(SKILL_NAME_PLACEHOLDER, skill)
}

/**
 * Replace the marked block in a source file, or insert it when absent.
 * `body` is the block content without the marker lines.
 */
export function replaceBlock(content, body) {
  const block = `${BEGIN_MARKER}\n${body}\n${END_MARKER}`
  const existing = extractBlock(content)
  if (existing) return content.replace(existing, block)
  const insertAt = content.indexOf('\n\n')
  if (insertAt === -1) return `${content.trimEnd()}\n\n${block}\n`
  const head = content.slice(0, insertAt)
  const tail = content.slice(insertAt).replace(/^\n+/, '').replace(/\n+$/, '')
  return `${head}\n\n${block}\n\n${tail}\n`
}

/** The lines that differ between two blocks, as a unified-ish diff. */
export function diffBlocks(expected, actual) {
  const expectedLines = (expected ?? '').split('\n')
  const actualLines = (actual ?? '').split('\n')
  const out = []
  const max = Math.max(expectedLines.length, actualLines.length)
  for (let i = 0; i < max; i++) {
    if (expectedLines[i] === actualLines[i]) continue
    if (actualLines[i] !== undefined) out.push(`- ${actualLines[i]}`)
    if (expectedLines[i] !== undefined) out.push(`+ ${expectedLines[i]}`)
  }
  return out.join('\n')
}

/**
 * Compare / rewrite the clients against the template.
 * Returns { exitCode, output } so both the CLI and the test observe the same
 * behaviour.
 */
export function runSync({ root = ROOT, templatePath = TEMPLATE_PATH, clients = CLIENTS, check = false }) {
  const out = []
  const template = readFileSync(templatePath, 'utf8')
  const templateBody = extractBlockBody(template)
  if (templateBody === null) {
    return {
      exitCode: 1,
      output: `Error: template ${relative(root, templatePath)} has no AUTH-BLOCK markers`,
    }
  }

  const drifted = []
  for (const { skill, path } of clients) {
    const fullPath = join(root, path)
    let content
    try {
      content = readFileSync(fullPath, 'utf8')
    } catch {
      return { exitCode: 1, output: `Error: missing client file ${path}` }
    }
    const expected = renderBlock(templateBody, skill)
    const actual = extractBlockBody(content)
    if (actual === expected) continue
    drifted.push(path)
    if (check) {
      out.push(`Error: ${path} drifted from the AUTH-BLOCK template`)
      const diff = diffBlocks(expected, actual)
      if (diff) out.push(diff)
    } else {
      writeFileSync(fullPath, replaceBlock(content, expected))
      out.push(`updated ${path}`)
    }
  }

  if (check) {
    if (drifted.length > 0) {
      out.push(`${drifted.length} client(s) out of sync. Run: node scripts/sync-client-auth.mjs`)
      return { exitCode: 1, output: out.join('\n') }
    }
    out.push(`All ${clients.length} skill clients match the AUTH-BLOCK template.`)
    return { exitCode: 0, output: out.join('\n') }
  }

  out.push(`Synced ${clients.length - drifted.length}/${clients.length} skill clients.`)
  return { exitCode: 0, output: out.join('\n') }
}

function main(argv) {
  const result = runSync({ check: argv.includes('--check') })
  if (result.exitCode === 0) console.log(result.output)
  else console.error(result.output)
  return result.exitCode
}

// Only run as a CLI; the exported helpers are imported by the unit test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
