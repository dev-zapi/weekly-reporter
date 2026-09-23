import Database from 'better-sqlite3'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { applyDatabaseMigrations } from './migrations'

const migrationsFolder = path.join(process.cwd(), 'drizzle')

function createProductionDriftDatabase(options: { partialScoring?: boolean } = {}) {
  const sqlite = new Database(':memory:')
  const finalScoringColumns = options.partialScoring
    ? ''
    : `
      score_error TEXT,
      scored_at INTEGER,`

  sqlite.exec(`
    CREATE TABLE __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
    INSERT INTO __drizzle_migrations (hash, created_at)
    VALUES ('0016', 1784534286451);

    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ai_style_override TEXT,
      score_status TEXT NOT NULL DEFAULT 'pending',
      score_structure INTEGER,
      score_content INTEGER,
      score_value INTEGER,
      score_overall INTEGER,
      suggestions TEXT,
      ${finalScoringColumns}
      legacy_marker TEXT
    );
    INSERT INTO reports (
      title, content, week_start, week_end, created_at, updated_at,
      score_status, score_overall
    ) VALUES (
      '旧周报', '旧版终稿', '2026-08-10', '2026-08-16',
      1786900000000, 1786900000000, 'completed', 88
    );

    CREATE TABLE collect_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT true,
      last_sync_at INTEGER,
      last_sync_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT DEFAULT 'enabled',
      project_scope TEXT NOT NULL DEFAULT 'personal'
    );

    CREATE TABLE ai_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'openai',
      api_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      model_list_cache TEXT,
      model_list_cached_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO ai_config (
      protocol, api_url, api_key, model, created_at, updated_at
    ) VALUES (
      'anthropic', 'https://example.com', 'secret', 'test-model',
      1786900000000, 1786900000000
    );

    CREATE TABLE ai_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      temperature TEXT NOT NULL DEFAULT '0.3',
      score_structure_weight INTEGER NOT NULL DEFAULT 25,
      score_content_weight INTEGER NOT NULL DEFAULT 30,
      score_value_weight INTEGER NOT NULL DEFAULT 45,
      detail_level TEXT,
      result_oriented TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE system_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      event_time INTEGER NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      category TEXT,
      section_type TEXT NOT NULL DEFAULT 'routine',
      tags TEXT,
      is_important INTEGER DEFAULT false,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      source_template_id TEXT,
      ai_style TEXT DEFAULT 'formal',
      config TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  return sqlite
}

function columnNames(sqlite: Database.Database, table: string): string[] {
  return sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()
    .map((row) => (row as { name: string }).name)
}

describe('applyDatabaseMigrations', () => {
  it('applies the complete migration chain to a new SQLite database', () => {
    const sqlite = new Database(':memory:')

    applyDatabaseMigrations(sqlite, migrationsFolder)

    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_variants'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_event_snapshots'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_sessions'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_message_parts'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_proposals'").get()).toBeTruthy()
    expect(columnNames(sqlite, 'templates')).toContain('source_template_id')
    expect(columnNames(sqlite, 'report_variants')).toContain('accepted_proposal_id')
    expect(columnNames(sqlite, 'report_variants')).toContain('structure_completeness_rule')
    expect(columnNames(sqlite, 'generation_sessions')).toContain('carry_forward_snapshot')
    expect(columnNames(sqlite, 'generation_proposals')).toEqual(expect.arrayContaining(['public_summary', 'baseline_content']))
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_plan_overrides'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_tags'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_references'").get()).toBeTruthy()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 35 })

    sqlite.close()
  })

  it('reconciles the production drift and completes later migrations without losing reports', () => {
    const sqlite = createProductionDriftDatabase()

    applyDatabaseMigrations(sqlite, migrationsFolder)

    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_variants'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_event_snapshots'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_sessions'").get()).toBeTruthy()
    expect(columnNames(sqlite, 'generation_sessions')).toContain('carry_forward_snapshot')
    expect(columnNames(sqlite, 'report_variants')).toContain('structure_completeness_rule')
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get()).toBeUndefined()
    expect(columnNames(sqlite, 'raw_events')).not.toContain('tags')
    expect(columnNames(sqlite, 'raw_events')).not.toContain('section_type')
    expect(columnNames(sqlite, 'templates')).not.toContain('config')

    expect(sqlite.prepare('SELECT protocol, model FROM ai_config').get()).toEqual({
      protocol: 'anthropic',
      model: 'test-model',
    })
    const protocolColumn = sqlite.prepare("PRAGMA table_info('ai_config')").all()
      .find((row) => (row as { name: string }).name === 'protocol') as { dflt_value: string }
    expect(protocolColumn.dflt_value).toBe("'openai-compatible'")

    expect(sqlite.prepare('SELECT title, content FROM reports WHERE id = 1').get()).toEqual({
      title: '旧周报',
      content: '旧版终稿',
    })
    expect(sqlite.prepare('SELECT * FROM report_variants').all()).toEqual([])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM report_event_snapshots').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT MAX(created_at) AS createdAt FROM __drizzle_migrations').get()).toEqual({
      createdAt: 1790134203630,
    })

    sqlite.close()
  })

  it('fails loudly when the scoring migration is only partially reflected in the schema', () => {
    const sqlite = createProductionDriftDatabase({ partialScoring: true })

    expect(() => applyDatabaseMigrations(sqlite, migrationsFolder)).toThrow(/partially applied/i)
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_variants'").get()).toBeUndefined()

    sqlite.close()
  })
})
