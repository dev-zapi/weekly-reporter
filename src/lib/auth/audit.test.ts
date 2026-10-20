import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { apiAuditLog } from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { recordAudit, writeAudit } from './audit'

function makeRequest(
  url = 'http://localhost:6868/api/events',
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
  })
}

describe('audit', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(() => {
    testDb = createTestDbWithMigrations()
  })

  afterEach(() => {
    const client = (testDb as unknown as { $client?: { close?: () => void } }).$client
    client?.close?.()
  })

  function rows() {
    return testDb.select().from(apiAuditLog).all()
  }

  describe('field mapping', () => {
    it('maps method, api path, status and user agent from the request', () => {
      writeAudit(
        testDb,
        makeRequest('http://localhost:6868/api/events', {
          method: 'POST',
          headers: { 'user-agent': 'node-fetch/1.0' },
        }),
        200,
        'my-agent',
      )

      const row = rows()[0]
      expect(row.method).toBe('POST')
      expect(row.apiPath).toBe('/api/events')
      expect(row.status).toBe(200)
      expect(row.userAgent).toBe('node-fetch/1.0')
      expect(row.patName).toBe('my-agent')
      expect(row.outcome).toBe('success')
      expect(row.createdAt).toBeGreaterThan(0)
    })

    it('maps the self-reported agent identity and caller cwd headers', () => {
      writeAudit(
        testDb,
        makeRequest('http://localhost:6868/api/events', {
          headers: {
            'X-Weekly-Reporter-Agent': 'weekly-reports/claude-code',
            'X-Weekly-Reporter-Cwd': '/home/user/project',
          },
        }),
        200,
        'my-agent',
      )

      const row = rows()[0]
      expect(row.agentIdentity).toBe('weekly-reports/claude-code')
      expect(row.callerCwd).toBe('/home/user/project')
    })

    it('leaves agent identity and caller cwd null when the headers are absent', () => {
      writeAudit(testDb, makeRequest(), 200, 'my-agent')

      const row = rows()[0]
      expect(row.agentIdentity).toBeNull()
      expect(row.callerCwd).toBeNull()
    })

    it('records a null pat name when the PAT could not be identified', () => {
      writeAudit(testDb, makeRequest(), 401, null)

      expect(rows()[0].patName).toBeNull()
    })
  })

  describe('outcome', () => {
    it('marks a 401 as unauthorized', () => {
      writeAudit(testDb, makeRequest(), 401, 'my-agent')

      const row = rows()[0]
      expect(row.status).toBe(401)
      expect(row.outcome).toBe('unauthorized')
    })

    it('marks a non-401 as success', () => {
      writeAudit(testDb, makeRequest(), 500, 'my-agent')

      expect(rows()[0].outcome).toBe('success')
    })
  })

  describe('recordAudit', () => {
    it('records a PAT call', async () => {
      await recordAudit(() => testDb, makeRequest(), 200, {
        mode: 'pat',
        patName: 'my-agent',
      })

      expect(rows()).toHaveLength(1)
      expect(rows()[0].patName).toBe('my-agent')
    })

    it('does not record a browser (startup password) call', async () => {
      await recordAudit(() => testDb, makeRequest(), 200, { mode: 'password' })

      expect(rows()).toHaveLength(0)
    })

    it('does not record when authentication is disabled', async () => {
      await recordAudit(() => testDb, makeRequest(), 200, { mode: 'disabled' })

      expect(rows()).toHaveLength(0)
    })

    it('does not open a database connection for a non-PAT call', async () => {
      let opened = false
      const getDatabase = () => {
        opened = true
        return testDb
      }

      await recordAudit(getDatabase, makeRequest(), 200, { mode: 'password' })

      expect(opened).toBe(false)
    })

    it('records the real status the handler produced', async () => {
      await recordAudit(() => testDb, makeRequest(), 404, {
        mode: 'pat',
        patName: 'my-agent',
      })

      expect(rows()[0].status).toBe(404)
    })
  })

  describe('failure tolerance', () => {
    it('swallows write errors instead of throwing', () => {
      const brokenDb = {
        insert: () => ({
          values: () => ({
            run: () => {
              throw new Error('database is locked')
            },
          }),
        }),
      } as unknown as ReturnType<typeof createTestDbWithMigrations>

      expect(() => writeAudit(brokenDb, makeRequest(), 200, 'my-agent')).not.toThrow()
    })
  })
})
