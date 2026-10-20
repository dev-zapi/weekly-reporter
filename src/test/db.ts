import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/lib/db/schema'
import fs from 'node:fs'
import path from 'node:path'

/**
 * In-memory SQLite database with every migration under drizzle/ applied, for
 * route and data-layer tests. The migrations directory is resolved from the
 * repo root so callers can live anywhere under src/.
 */
export function createTestDbWithMigrations() {
  const sqlite = new Database(':memory:')

  const migrationsDir = path.join(__dirname, '../../drizzle')
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const migrationPath = path.join(migrationsDir, file)
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8')
    const statements = migrationSql.split('--> statement-breakpoint')
    for (const stmt of statements) {
      const trimmed = stmt.trim()
      if (trimmed) {
        sqlite.exec(trimmed)
      }
    }
  }

  return drizzle(sqlite, { schema })
}
