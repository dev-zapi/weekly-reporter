#!/usr/bin/env node
/**
 * Codemod: wrap every exported HTTP handler in src/app/api/**\/route.ts with withAuth.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

function findRouteFiles(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findRouteFiles(full))
    } else if (entry.name === 'route.ts') {
      results.push(full)
    }
  }
  return results
}

/**
 * Given the start index of a '{', find the matching '}'.
 * Handles nested braces, strings (single, double, template), and comments.
 */
function findMatchingBrace(src, startIdx) {
  let depth = 0
  let i = startIdx

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    // Skip single-line comments
    if (ch === '/' && next === '/') {
      i += 2
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    // Skip multi-line comments
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }

    // Skip strings
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === quote) break
        i++
      }
      i++ // skip closing quote
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }

    i++
  }

  return -1
}

function transformFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')

  // Skip if already transformed
  if (src.includes('withAuth')) {
    return { changed: false, handlers: 0 }
  }

  const handlers = []
  const replacements = []

  // Find all exported async function declarations for HTTP methods
  for (const method of HTTP_METHODS) {
    const pattern = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`, 'g')
    let match

    while ((match = pattern.exec(src)) !== null) {
      const funcStartIdx = match.index

      // Find the opening parenthesis
      const parenStartIdx = match.index + match[0].length - 1

      // Find the matching closing parenthesis
      let parenDepth = 1
      let searchIdx = parenStartIdx + 1
      while (searchIdx < src.length && parenDepth > 0) {
        const ch = src[searchIdx]
        if (ch === '(') parenDepth++
        else if (ch === ')') parenDepth--
        searchIdx++
      }

      // Find the opening brace after the closing paren
      let braceStartIdx = searchIdx
      while (braceStartIdx < src.length && src[braceStartIdx] !== '{') {
        braceStartIdx++
      }

      if (braceStartIdx >= src.length) continue

      // Find the matching closing brace
      const braceEndIdx = findMatchingBrace(src, braceStartIdx)
      if (braceEndIdx === -1) continue

      handlers.push(method)

      // Build the replacement:
      // "export async function METHOD(...) { ... }"
      // → "export const METHOD = withAuth(async function METHOD(...) { ... })"
      const originalText = src.slice(funcStartIdx, braceEndIdx + 1)
      const funcText = originalText.replace(/^export\s+/, '')
      const replacement = `export const ${method} = withAuth(${funcText})`

      replacements.push({
        start: funcStartIdx,
        end: braceEndIdx + 1,
        replacement,
      })
    }
  }

  if (replacements.length === 0) {
    return { changed: false, handlers: 0 }
  }

  // Apply replacements in reverse order
  replacements.sort((a, b) => b.start - a.start)
  let result = src
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end)
  }

  // Add import at the top
  const importLine = `import { withAuth } from '@/lib/auth/guard'\n`
  const firstImportMatch = result.match(/^import\s/m)
  if (firstImportMatch) {
    const insertIdx = firstImportMatch.index
    result = result.slice(0, insertIdx) + importLine + result.slice(insertIdx)
  } else {
    result = importLine + result
  }

  return { changed: true, handlers: handlers.length, newSrc: result }
}

// Main
const checkOnly = process.argv.includes('--check')
const apiDir = path.join(ROOT, 'src/app/api')
const files = findRouteFiles(apiDir)

let totalHandlers = 0
let changedFiles = 0
let fail = false

for (const f of files) {
  const result = transformFile(f)
  totalHandlers += result.handlers
  if (result.changed) {
    changedFiles++
    if (checkOnly) {
      console.log(`Would modify: ${path.relative(ROOT, f)} (${result.handlers} handlers)`)
      fail = true
    } else {
      fs.writeFileSync(f, result.newSrc, 'utf8')
      console.log(`Modified: ${path.relative(ROOT, f)} (${result.handlers} handlers)`)
    }
  }
}

console.log(`\nTotal: ${files.length} files, ${totalHandlers} handlers wrapped across ${changedFiles} files`)

if (checkOnly && fail) {
  process.exit(1)
}
