import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * CI assertion: every exported HTTP handler in src/app/api/**\/route.ts must be
 * wrapped by withAuth. This prevents the classic mistake of forgetting to add
 * authentication to a new route.
 *
 * The check is deliberately strict about *how* the handler is exported: it must
 * be the `withAuth(...)` binding itself (`export const GET = withAuth(`), not a
 * bare `export function GET(` / `export async function GET(` and not merely a
 * file that mentions `withAuth` somewhere.
 *
 * Spec: §1.7
 */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

function findRouteFiles(dir: string): string[] {
  const results: string[] = []
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
 * Return one message per violating export across the given route files.
 *
 * A violation is an exported HTTP method whose *export line* is not
 * `export const METHOD = withAuth(`. This catches:
 *   - `export async function GET(...)`  (async function form)
 *   - `export function POST(...)`       (sync function form)
 *   - `export const GET = somethingElse(...)` / any non-withAuth binding
 * and does not accept a `withAuth` reference that lives anywhere else in the
 * file (e.g. a comment, an import, or a nested call).
 */
function collectViolations(routeFiles: string[]): string[] {
  const violations: string[] = []

  for (const filePath of routeFiles) {
    const content = fs.readFileSync(filePath, 'utf8')
    const relativePath = path.relative(process.cwd(), filePath)

    if (!content.includes('withAuth')) {
      violations.push(`${relativePath}: missing withAuth import`)
      continue
    }

    for (const line of content.split('\n')) {
      const exported = /^export\s+(?:const\s+([A-Za-z_$][\w$]*)|(?:async\s+)?function\s+([A-Za-z_$][\w$]*))/.exec(
        line,
      )
      if (!exported) continue
      const name = exported[1] ?? exported[2]
      if (!HTTP_METHODS.includes(name)) continue

      const wrapped = new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*withAuth\\(`).test(line)
      if (!wrapped) {
        violations.push(`${relativePath}: ${name} handler is not wrapped with withAuth`)
      }
    }
  }

  return violations
}

/** Write a throwaway route.ts fixture and return its path. */
function writeRouteFixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-coverage-'))
  const file = path.join(dir, 'route.ts')
  fs.writeFileSync(file, content)
  return file
}

describe('Route authentication coverage', () => {
  const API_DIR = path.join(process.cwd(), 'src/app/api')

  it('wraps every exported HTTP handler with withAuth', () => {
    const routeFiles = findRouteFiles(API_DIR)
    expect(routeFiles.length).toBeGreaterThan(0)

    const violations = collectViolations(routeFiles)

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} route(s) with unwrapped handlers:\n\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        '\n\nAll HTTP handlers must be wrapped with withAuth() for authentication.\n' +
        'Example: export const GET = withAuth(async function GET(request: Request) { ... })'
      )
    }
  })

  it('covers all 53 route files', () => {
    const routeFiles = findRouteFiles(API_DIR)
    // Spec mentions 53 route files. This assertion ensures we don't accidentally
    // exclude files from the check.
    expect(routeFiles.length).toBeGreaterThanOrEqual(53)
  })

  describe('collectViolations (red/green cases)', () => {
    it('flags an unwrapped async function export (red case)', () => {
      const file = writeRouteFixture(
        'import { withAuth } from "@/lib/auth/guard"\n' +
        'export async function GET(request: Request) {\n' +
        '  return new Response("ok")\n' +
        '}\n',
      )

      const violations = collectViolations([file])

      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('GET handler is not wrapped with withAuth')
    })

    it('flags an unwrapped synchronous function export (red case)', () => {
      const file = writeRouteFixture(
        'import { withAuth } from "@/lib/auth/guard"\n' +
        'export function POST(request: Request) {\n' +
        '  return new Response("ok")\n' +
        '}\n',
      )

      const violations = collectViolations([file])

      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('POST handler is not wrapped with withAuth')
    })

    it('flags a file that never mentions withAuth (red case)', () => {
      const file = writeRouteFixture(
        'export async function GET(request: Request) {\n' +
        '  return new Response("ok")\n' +
        '}\n',
      )

      const violations = collectViolations([file])

      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('missing withAuth import')
    })

    it('rejects a withAuth reference that is not the export binding (red case)', () => {
      const file = writeRouteFixture(
        'import { withAuth } from "@/lib/auth/guard"\n' +
        '// withAuth is imported but GET is exported bare\n' +
        'export async function GET(request: Request) {\n' +
        '  return withAuth(async () => new Response("ok"))(request)\n' +
        '}\n',
      )

      const violations = collectViolations([file])

      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('GET handler is not wrapped with withAuth')
    })

    it('accepts the withAuth const binding (green case)', () => {
      const file = writeRouteFixture(
        'import { withAuth } from "@/lib/auth/guard"\n' +
        'export const GET = withAuth(async function GET(request: Request) {\n' +
        '  return new Response("ok")\n' +
        '})\n',
      )

      expect(collectViolations([file])).toEqual([])
    })
  })
})
