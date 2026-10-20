import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * CI assertion: every exported HTTP handler in src/app/api/**\/route.ts must be
 * wrapped by withAuth. This prevents the classic mistake of forgetting to add
 * authentication to a new route.
 *
 * Spec: §1.7
 */
describe('Route authentication coverage', () => {
  const API_DIR = path.join(process.cwd(), 'src/app/api')
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

  it('wraps every exported HTTP handler with withAuth', () => {
    const routeFiles = findRouteFiles(API_DIR)
    expect(routeFiles.length).toBeGreaterThan(0)

    const violations: string[] = []

    for (const filePath of routeFiles) {
      const content = fs.readFileSync(filePath, 'utf8')
      const relativePath = path.relative(process.cwd(), filePath)

      // Check that the file imports withAuth
      if (!content.includes('withAuth')) {
        violations.push(`${relativePath}: missing withAuth import`)
        continue
      }

      // Check that every exported HTTP handler is wrapped
      for (const method of HTTP_METHODS) {
        // Match: export async function METHOD(
        // This pattern catches unwrapped handlers like:
        //   export async function GET(request: Request) { ... }
        // But not wrapped ones like:
        //   export const GET = withAuth(async function GET(...) { ... })
        const unwrappedPattern = new RegExp(
          `^export\\s+async\\s+function\\s+${method}\\s*\\(`,
          'm'
        )

        if (unwrappedPattern.test(content)) {
          violations.push(`${relativePath}: ${method} handler is not wrapped with withAuth`)
        }
      }
    }

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
})
