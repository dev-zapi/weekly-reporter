import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { apiTokens } from '@/lib/db/schema'
import { createTestDbWithMigrations } from '@/test/db'
import {
  createPat,
  findPatByToken,
  generateToken,
  getTokenPrefix,
  hashToken,
  isPatExpired,
  isPatRevoked,
  listPats,
  revokePat,
  touchPat,
} from './pat'

describe('pat', () => {
  let testDb: ReturnType<typeof createTestDbWithMigrations>

  beforeEach(() => {
    testDb = createTestDbWithMigrations()
  })

  afterEach(() => {
    const client = (testDb as unknown as { $client?: { close?: () => void } }).$client
    client?.close?.()
  })

  describe('token format', () => {
    it('generates a token with the wrp_ prefix followed by 32 base62 characters', () => {
      const token = generateToken()

      expect(token).toMatch(/^wrp_[A-Za-z0-9]{32}$/)
    })

    it('generates a different token on every call', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateToken()))

      expect(tokens.size).toBe(50)
    })

    it('stores the first 8 characters of the plaintext as the display prefix', () => {
      const token = generateToken()

      expect(getTokenPrefix(token)).toBe(token.slice(0, 8))
      expect(getTokenPrefix(token)).toHaveLength(8)
    })
  })

  describe('hashing', () => {
    it('produces the SHA-256 hex digest of the token', () => {
      expect(hashToken('wrp_example')).toBe(
        '1dc41aa6813c105f3004919d7fd398fb1d5946d20693e2509adfd892c649e5e0',
      )
    })

    it('produces a 64-character lowercase hex digest', () => {
      expect(hashToken('wrp_a')).toHaveLength(64)
      expect(hashToken('wrp_a')).toMatch(/^[0-9a-f]{64}$/)
    })

    it('produces different digests for different tokens', () => {
      expect(hashToken('wrp_a')).not.toBe(hashToken('wrp_b'))
    })
  })

  describe('createPat', () => {
    it('returns the plaintext token exactly once at creation', () => {
      const created = createPat(testDb, 'my-agent')

      expect(created.token).toMatch(/^wrp_[A-Za-z0-9]{32}$/)
      expect(created.name).toBe('my-agent')
      expect(created.createdAt).toBeGreaterThan(0)
    })

    it('stores only the SHA-256 hash, never the plaintext', () => {
      const created = createPat(testDb, 'my-agent')

      const rows = testDb.select().from(apiTokens).all()
      expect(rows).toHaveLength(1)
      expect(rows[0].tokenHash).toBe(hashToken(created.token))
      expect(rows[0].tokenHash).not.toBe(created.token)
      expect(JSON.stringify(rows)).not.toContain(created.token)
    })

    it('stores the display prefix so the UI can identify the token', () => {
      const created = createPat(testDb, 'my-agent')

      const rows = testDb.select().from(apiTokens).all()
      expect(rows[0].prefix).toBe(created.token.slice(0, 8))
    })

    it('defaults to never expiring', () => {
      createPat(testDb, 'my-agent')

      const rows = testDb.select().from(apiTokens).all()
      expect(rows[0].expiresAt).toBeNull()
      expect(rows[0].revokedAt).toBeNull()
      expect(rows[0].lastUsedAt).toBeNull()
    })

    it('honours an explicit expiry timestamp', () => {
      const expiresAt = Date.now() + 60_000

      createPat(testDb, 'my-agent', { expiresAt })

      const rows = testDb.select().from(apiTokens).all()
      expect(rows[0].expiresAt).toBe(expiresAt)
    })

    it('never exposes the plaintext again through listPats', () => {
      const created = createPat(testDb, 'my-agent')

      const listed = listPats(testDb)

      expect(listed).toHaveLength(1)
      expect(listed[0].name).toBe('my-agent')
      expect(listed[0].prefix).toBe(created.token.slice(0, 8))
      expect(JSON.stringify(listed)).not.toContain(created.token)
      expect(JSON.stringify(listed)).not.toContain(hashToken(created.token))
    })
  })

  describe('findPatByToken', () => {
    it('finds a PAT by its plaintext token', () => {
      const created = createPat(testDb, 'my-agent')

      const found = findPatByToken(testDb, created.token)

      expect(found).not.toBeNull()
      expect(found!.name).toBe('my-agent')
    })

    it('returns null for an unknown token', () => {
      expect(findPatByToken(testDb, 'wrp_doesnotexist')).toBeNull()
    })
  })

  describe('revokePat', () => {
    it('marks the token revoked without deleting the row', () => {
      const created = createPat(testDb, 'my-agent')

      const revoked = revokePat(testDb, created.id)

      expect(revoked).toBe(true)
      const found = findPatByToken(testDb, created.token)
      expect(found).not.toBeNull()
      expect(isPatRevoked(found!)).toBe(true)
    })

    it('reports false when the token does not exist', () => {
      expect(revokePat(testDb, 9999)).toBe(false)
    })

    it('is idempotent — a second revoke keeps the original timestamp', () => {
      const created = createPat(testDb, 'my-agent')
      revokePat(testDb, created.id)
      const firstRevokedAt = findPatByToken(testDb, created.token)!.revokedAt

      expect(revokePat(testDb, created.id)).toBe(false)
      expect(findPatByToken(testDb, created.token)!.revokedAt).toBe(firstRevokedAt)
    })
  })

  describe('expiry', () => {
    it('treats a token with no expiry as never expired', () => {
      const created = createPat(testDb, 'my-agent')
      const found = findPatByToken(testDb, created.token)!

      expect(isPatExpired(found)).toBe(false)
    })

    it('treats a token whose expiry is in the past as expired', () => {
      const expired = createPat(testDb, 'expired', { expiresAt: Date.now() - 1000 })
      const row = findPatByToken(testDb, expired.token)!

      expect(isPatExpired(row)).toBe(true)
    })

    it('treats a token whose expiry is in the future as valid', () => {
      const created = createPat(testDb, 'my-agent', { expiresAt: Date.now() + 60_000 })
      const found = findPatByToken(testDb, created.token)!

      expect(isPatExpired(found)).toBe(false)
    })
  })

  describe('touchPat', () => {
    it('records the time the token was last used', () => {
      const created = createPat(testDb, 'my-agent')
      expect(findPatByToken(testDb, created.token)!.lastUsedAt).toBeNull()

      touchPat(testDb, created.id)

      expect(findPatByToken(testDb, created.token)!.lastUsedAt).not.toBeNull()
    })
  })

  describe('listPats', () => {
    it('returns metadata for every token, newest first', () => {
      createPat(testDb, 'older')
      createPat(testDb, 'newer')

      const listed = listPats(testDb)

      expect(listed.map((p) => p.name)).toEqual(['newer', 'older'])
    })
  })
})
