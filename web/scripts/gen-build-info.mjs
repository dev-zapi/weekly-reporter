// Generate web/src/build-info.ts with the commit hash and build time.
//
// Same approach as the long-standing root scripts/gen-build-info.mjs: emit a
// constants module at build/dev time, then import it through the `@/lib/build-info`
// alias (ADR-0028). The Go binary carries its own build info via `-ldflags -X`
// into internal/buildinfo (ADR-0025); the two tracks coexist until cutover.
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
