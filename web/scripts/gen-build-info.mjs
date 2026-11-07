// Generate web/src/build-info.ts with the commit hash and build time.
//
// Same pattern as the root scripts/gen-build-info.mjs (ADR-0028): the build
// produces a constant module, and the `@/lib/build-info` alias points at it so
// the migrated components keep their existing import specifier. The Go side
// carries the same values via -ldflags (internal/buildinfo).
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let commitHash = ''
try {
  commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()
} catch {
  commitHash = 'unknown'
}

const content = `// Auto-generated at build time. Do not edit.
export const COMMIT_HASH = '${commitHash}'
export const BUILD_TIME = '${new Date().toISOString()}'
`

writeFileSync(path.join(webDir, 'src/build-info.ts'), content)
console.log('web/src/build-info.ts generated')
