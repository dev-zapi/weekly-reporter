import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  diffBlocks,
  extractBlock,
  extractBlockBody,
  renderBlock,
  replaceBlock,
  runSync,
} from './sync-client-auth.mjs'

const TEMPLATE = [
  '// >>> AUTH-BLOCK:BEGIN (generated)',
  'export const SKILL_NAME = \'__SKILL_NAME__\'',
  'export const PAT = process.env.WEEKLY_REPORTER_PAT || null',
  '// <<< AUTH-BLOCK:END',
  '',
].join('\n')

const TEMPLATE_BODY = [
  'export const SKILL_NAME = \'__SKILL_NAME__\'',
  'export const PAT = process.env.WEEKLY_REPORTER_PAT || null',
].join('\n')

function fixture(clientBody) {
  const root = mkdtempSync(join(tmpdir(), 'sync-client-auth-'))
  const templatePath = join(root, 'template.mjs')
  writeFileSync(templatePath, TEMPLATE)
  const clientPath = join(root, 'client.mjs')
  mkdirSync(join(root, 'skill'), { recursive: true })
  writeFileSync(clientPath, clientBody)
  return { root, templatePath, clientPath }
}

describe('extractBlock', () => {
  it('returns the marked region including its markers', () => {
    expect(extractBlock(TEMPLATE)).toBe(
      "// >>> AUTH-BLOCK:BEGIN (generated)\n"
      + "export const SKILL_NAME = '__SKILL_NAME__'\n"
      + 'export const PAT = process.env.WEEKLY_REPORTER_PAT || null\n'
      + '// <<< AUTH-BLOCK:END',
    )
  })

  it('returns null when the markers are missing', () => {
    expect(extractBlock('export const BASE_URL = 1\n')).toBeNull()
  })

  it('returns null when the end marker is missing', () => {
    expect(extractBlock('// >>> AUTH-BLOCK:BEGIN\nconst a = 1\n')).toBeNull()
  })
})

describe('extractBlockBody', () => {
  it('returns the marked region without the marker lines', () => {
    expect(extractBlockBody(TEMPLATE)).toBe(TEMPLATE_BODY)
  })

  it('returns null when the markers are missing', () => {
    expect(extractBlockBody('export const BASE_URL = 1\n')).toBeNull()
  })
})

describe('renderBlock', () => {
  it('substitutes the skill name placeholder', () => {
    const block = renderBlock(extractBlockBody(TEMPLATE), 'weekly-reports')
    expect(block).toContain("export const SKILL_NAME = 'weekly-reports'")
    expect(block).not.toContain('__SKILL_NAME__')
  })
})

describe('replaceBlock', () => {
  it('replaces an existing block and leaves the rest untouched', () => {
    const content = [
      '// header',
      '',
      '// >>> AUTH-BLOCK:BEGIN',
      'old',
      '// <<< AUTH-BLOCK:END',
      '',
      'export const SKILL_ONLY = 1',
      '',
    ].join('\n')
    const result = replaceBlock(content, 'NEW BLOCK')
    expect(result).toBe(
      '// header\n\n// >>> AUTH-BLOCK:BEGIN\nNEW BLOCK\n// <<< AUTH-BLOCK:END\n\n'
      + 'export const SKILL_ONLY = 1\n',
    )
  })

  it('inserts the block after the leading comment header when absent', () => {
    const content = '// Shared helpers for the x skill.\n\nexport const A = 1\n'
    const result = replaceBlock(content, 'BLOCK')
    expect(result).toBe(
      '// Shared helpers for the x skill.\n\n// >>> AUTH-BLOCK:BEGIN\nBLOCK\n'
      + '// <<< AUTH-BLOCK:END\n\nexport const A = 1\n',
    )
  })
})

describe('diffBlocks', () => {
  it('reports the lines that differ', () => {
    const diff = diffBlocks('a\nb\nc\n', 'a\nX\nc\n')
    expect(diff).toContain('- X')
    expect(diff).toContain('+ b')
    expect(diff).not.toContain('- a')
  })

  it('returns an empty string for identical blocks', () => {
    expect(diffBlocks('a\nb\n', 'a\nb\n')).toBe('')
  })
})

describe('runSync', () => {
  it('exits 0 when every client matches the template', () => {
    const { root, templatePath, clientPath } = fixture(
      "// >>> AUTH-BLOCK:BEGIN\n"
      + "export const SKILL_NAME = 'x-skill'\n"
      + 'export const PAT = process.env.WEEKLY_REPORTER_PAT || null\n'
      + '// <<< AUTH-BLOCK:END\n',
    )
    const result = runSync({
      root,
      templatePath,
      clients: [{ skill: 'x-skill', path: 'client.mjs' }],
      check: true,
    })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(clientPath, 'utf8')).toContain('x-skill')
  })

  it('exits 1 and prints a diff when a client drifted', () => {
    const { root, templatePath } = fixture(
      "// >>> AUTH-BLOCK:BEGIN\n"
      + "export const SKILL_NAME = 'x-skill'\n"
      + 'export const PAT = null\n'
      + '// <<< AUTH-BLOCK:END\n',
    )
    const result = runSync({
      root,
      templatePath,
      clients: [{ skill: 'x-skill', path: 'client.mjs' }],
      check: true,
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('client.mjs')
    expect(result.output).toContain('- export const PAT = null')
    expect(result.output).toContain('+ export const PAT = process.env.WEEKLY_REPORTER_PAT || null')
  })

  it('exits 1 when a client file is missing', () => {
    const { root, templatePath } = fixture('')
    const result = runSync({
      root,
      templatePath,
      clients: [{ skill: 'x-skill', path: 'nope.mjs' }],
      check: true,
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('nope.mjs')
  })

  it('rewrites a drifted client when not in check mode', () => {
    const { root, templatePath, clientPath } = fixture(
      "// >>> AUTH-BLOCK:BEGIN\nold\n// <<< AUTH-BLOCK:END\n",
    )
    const result = runSync({
      root,
      templatePath,
      clients: [{ skill: 'x-skill', path: 'client.mjs' }],
      check: false,
    })
    expect(result.exitCode).toBe(0)
    const updated = readFileSync(clientPath, 'utf8')
    expect(updated).toContain("export const SKILL_NAME = 'x-skill'")
    expect(updated).not.toContain('old\n')
  })
})
