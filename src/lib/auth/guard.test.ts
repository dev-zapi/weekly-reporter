import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { apiAuditLog, apiTokens } from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import { createPat } from './pat'

vi.mock('@/lib/db', () => {
  const getDb = vi.fn()
  return { getDb }
})

vi.mock('@/lib/auth/password', () => ({
  readStartupPassword: vi.fn(() => null),
}))

import { getDb } from '@/lib/db'
import { readStartupPassword } from './password'
import { isAuthDisabled, requireAuth, timingSafeEqualString, withAuth } from './guard'

const mockedGetDb = getDb as unknown as ReturnType<typeof vi.fn>
const mockedReadPassword = readStartupPassword as unknown as ReturnType<typeof vi.fn>

/** setup.ts 默认把认证关掉；本文件要测开启后的行为，故先摘掉，测完还原 */
const originalAuthDisabled = process.env.WR_AUTH_DISABLED

function bearer(token: string): Request {
  return new Request('http://localhost:6868/api/events', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

function plain(): Request {
  return new Request('http://localhost:6868/api/events', { method: 'GET' })
}

describe('guard', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(() => {
    testDb = createTestDbWithMigrations()
    mockedGetDb.mockReturnValue(testDb)
    mockedReadPassword.mockReturnValue(null)
    delete process.env.WR_AUTH_DISABLED
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (originalAuthDisabled === undefined) {
      delete process.env.WR_AUTH_DISABLED
    } else {
      process.env.WR_AUTH_DISABLED = originalAuthDisabled
    }
  })

  function auditRows() {
    return testDb.select().from(apiAuditLog).all()
  }

  function patRows() {
    return testDb.select().from(apiTokens).all()
  }

  describe('WR_AUTH_DISABLED total switch', () => {
    it('short-circuits to mode=disabled when the env var is set to "1"', async () => {
      process.env.WR_AUTH_DISABLED = '1'

      const result = await requireAuth(plain())

      expect(result.ok).toBe(true)
      expect(result.mode).toBe('disabled')
      expect(mockedGetDb).not.toHaveBeenCalled()
      expect(mockedReadPassword).not.toHaveBeenCalled()
    })

    it('isAuthDisabled reflects the env var', () => {
      expect(isAuthDisabled()).toBe(false)
      process.env.WR_AUTH_DISABLED = '1'
      expect(isAuthDisabled()).toBe(true)
      process.env.WR_AUTH_DISABLED = '0'
      expect(isAuthDisabled()).toBe(false)
    })

    it('does not short-circuit for any other value of the env var', async () => {
      process.env.WR_AUTH_DISABLED = 'true'

      const result = await requireAuth(plain())

      expect(result.ok).toBe(false)
    })
  })

  describe('missing or malformed bearer', () => {
    it('returns a 401 when there is no Authorization header', async () => {
      const result = await requireAuth(plain())

      expect(result.ok).toBe(false)
      expect(result.response?.status).toBe(401)
      await expect(result.response!.json()).resolves.toEqual({ error: 'Unauthorized' })
    })

    it('returns a 401 for a non-Bearer scheme', async () => {
      const request = new Request('http://localhost:6868/api/events', {
        headers: { Authorization: 'Basic Zm9vOmJhcg==' },
      })

      const result = await requireAuth(request)

      expect(result.ok).toBe(false)
      expect(result.response?.status).toBe(401)
    })

    it('returns a 401 for an empty Bearer token', async () => {
      const request = new Request('http://localhost:6868/api/events', {
        headers: { Authorization: 'Bearer ' },
      })

      const result = await requireAuth(request)

      expect(result.ok).toBe(false)
      expect(result.response?.status).toBe(401)
    })
  })

  describe('startup password (browser) mode', () => {
    it('matches the stored startup password and reports mode="password"', async () => {
      mockedReadPassword.mockReturnValue('correct-startup-password')

      const result = await requireAuth(bearer('correct-startup-password'))

      expect(result.ok).toBe(true)
      expect(result.mode).toBe('password')
      expect(mockedGetDb).not.toHaveBeenCalled()
    })

    it('falls through to PAT lookup when the bearer does not match the password', async () => {
      mockedReadPassword.mockReturnValue('correct-startup-password')

      const result = await requireAuth(bearer('wrong-token'))

      expect(result.ok).toBe(false)
      expect(mockedGetDb).toHaveBeenCalled()
    })

    it('still tries PAT lookup when no password has been set', async () => {
      mockedReadPassword.mockReturnValue(null)

      const result = await requireAuth(bearer('wrp_anything'))

      expect(result.ok).toBe(false)
      expect(mockedGetDb).toHaveBeenCalled()
    })
  })

  describe('PAT mode', () => {
    it('authenticates a valid PAT and touches its lastUsedAt', async () => {
      const created = createPat(testDb, 'my-agent')

      const result = await requireAuth(bearer(created.token))

      expect(result.ok).toBe(true)
      expect(result.mode).toBe('pat')
      expect(result.patName).toBe('my-agent')
      expect(patRows()[0].lastUsedAt).not.toBeNull()
    })

    it('records an audit row with pat_name=null when the token is unknown', async () => {
      const result = await requireAuth(bearer('wrp_doesnotexist'))

      expect(result.ok).toBe(false)
      expect(result.response?.status).toBe(401)
      expect(auditRows()).toHaveLength(1)
      expect(auditRows()[0].patName).toBeNull()
      expect(auditRows()[0].outcome).toBe('unauthorized')
      expect(auditRows()[0].status).toBe(401)
    })

    it('records an audit row with the PAT name when the PAT has been revoked', async () => {
      const created = createPat(testDb, 'revoked-agent')
      const pat = patRows()[0]
      testDb
        .update(apiTokens)
        .set({ revokedAt: Date.now() - 1 })
        .where(eq(apiTokens.id, pat.id))
        .run()

      const result = await requireAuth(bearer(created.token))

      expect(result.ok).toBe(false)
      expect(auditRows()[0].patName).toBe('revoked-agent')
      expect(auditRows()[0].outcome).toBe('unauthorized')
    })

    it('records an audit row with the PAT name when the PAT has expired', async () => {
      const created = createPat(testDb, 'expired-agent', {
        expiresAt: Date.now() - 1000,
      })

      const result = await requireAuth(bearer(created.token))

      expect(result.ok).toBe(false)
      expect(auditRows()[0].patName).toBe('expired-agent')
      expect(auditRows()[0].outcome).toBe('unauthorized')
    })
  })

  describe('timingSafeEqualString (constant-time comparison)', () => {
    it('returns true for equal strings', () => {
      expect(timingSafeEqualString('abc', 'abc')).toBe(true)
      expect(timingSafeEqualString('', '')).toBe(true)
    })

    it('returns false for different strings of the same length', () => {
      expect(timingSafeEqualString('abc', 'abd')).toBe(false)
    })

    it('returns false for strings of different lengths without throwing', () => {
      expect(() => timingSafeEqualString('short', 'much-longer-string')).not.toThrow()
      expect(timingSafeEqualString('short', 'much-longer-string')).toBe(false)
    })
  })

  describe('withAuth', () => {
    it('returns a 401 without invoking the handler when authentication fails', async () => {
      const handler = vi.fn<(req: Request, ctx?: unknown) => Promise<Response>>(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )
      const wrapped = withAuth(handler)

      const response = await wrapped(plain())

      expect(response.status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
    })

    it('invokes the handler and records an audit with the real status', async () => {
      const created = createPat(testDb, 'my-agent')
      const handler = vi.fn<(req: Request, ctx?: unknown) => Promise<Response>>(
        async () => new Response('not found', { status: 404 }),
      )
      const wrapped = withAuth(handler)

      const response = await wrapped(bearer(created.token), {})

      expect(response.status).toBe(404)
      expect(handler).toHaveBeenCalled()
      expect(auditRows()).toHaveLength(1)
      expect(auditRows()[0].status).toBe(404)
      expect(auditRows()[0].patName).toBe('my-agent')
      expect(auditRows()[0].outcome).toBe('success')
    })

    it('does not record an audit row for a password (browser) call', async () => {
      mockedReadPassword.mockReturnValue('pw')
      const handler = vi.fn<(req: Request, ctx?: unknown) => Promise<Response>>(
        async () => new Response('ok', { status: 200 }),
      )
      const wrapped = withAuth(handler)

      await wrapped(bearer('pw'), {})

      expect(auditRows()).toHaveLength(0)
    })

    it('passes the Next 16 context argument through unchanged', async () => {
      const created = createPat(testDb, 'my-agent')
      let capturedCtx: unknown = 'not-called'
      const handler = vi.fn(async (_req: Request, ctx: unknown) => {
        capturedCtx = ctx
        return new Response('ok')
      })
      const wrapped = withAuth(handler)
      const fakeContext = { params: Promise.resolve({ id: '42' }) }

      await wrapped(bearer(created.token), fakeContext)

      expect(capturedCtx).toBe(fakeContext)
    })
  })

  describe('proxy configuration (CI guard)', () => {
    it('src/proxy.ts exists under src/ and not at the repo root', () => {
      expect(fs.existsSync(path.join(process.cwd(), 'src/proxy.ts'))).toBe(true)
      expect(fs.existsSync(path.join(process.cwd(), 'proxy.ts'))).toBe(false)
    })

    it('config.matcher is the constant string "/api/:path*"', async () => {
      const proxyModule = await import('../../proxy')

      expect(proxyModule.config).toBeDefined()
      expect(proxyModule.config.matcher).toBe('/api/:path*')
    })

    it('exports a proxy function', async () => {
      const proxyModule = await import('../../proxy')

      expect(typeof proxyModule.proxy).toBe('function')
    })
  })
})
