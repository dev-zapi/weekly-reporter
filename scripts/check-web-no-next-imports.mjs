#!/usr/bin/env node
// Guard for the B7 acceptance criterion "SPA side has zero next/* imports".
//
// The SPA lives in web/src (the Next app under repo-root src/ stays untouched
// until the B8 cutover, so this guard deliberately does not scan it).
// Fails closed: any `next/<module>` import - static, dynamic or re-export -
// makes the command exit non-zero.
import { readdirSync, readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(repoRoot, 'web/src')
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const NEXT_IMPORT = /\bfrom\s*['"]next\/[^'"]*['"]|\bimport\s*\(\s*['"]next\/[^'"]*['"]|\brequire\s*\(\s*['"]next\/[^'"]*['"]|\bimport\s*['"]next\/[^'"]*['"]/g

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) yield full
  }
}

let violations = 0
let scanned = 0

try {
  if (!statSync(target).isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`check-web-no-next-imports: missing directory ${path.relative(repoRoot, target)}`)
  process.exit(1)
}

for (const file of walk(target)) {
  scanned += 1
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const matches = line.match(NEXT_IMPORT)
    if (!matches) return
    for (const match of matches) {
      violations += 1
      console.error(`${path.relative(repoRoot, file)}:${index + 1}: ${match.trim()}`)
    }
  })
}

if (violations > 0) {
  console.error(`check-web-no-next-imports: ${violations} next/* import(s) in web/src (scanned ${scanned} files)`)
  process.exit(1)
}

console.log(`check-web-no-next-imports: OK (${scanned} files, zero next/* imports)`)
