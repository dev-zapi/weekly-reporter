import { describe, it, expect } from 'vitest'
import { getPatStatus, type PatMetadata } from './pat-shared'

function pat(overrides: Partial<PatMetadata> = {}): PatMetadata {
  return {
    id: 1,
    name: 'test',
    prefix: 'wrp_aBcD',
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('getPatStatus', () => {
  it('reports active when neither revoked nor expired', () => {
    expect(getPatStatus(pat())).toBe('active')
    expect(getPatStatus(pat({ expiresAt: Date.now() + 60_000 }))).toBe('active')
  })

  it('reports expired when expiresAt is in the past', () => {
    expect(getPatStatus(pat({ expiresAt: Date.now() - 1_000 }))).toBe('expired')
  })

  it('reports revoked when revokedAt is set', () => {
    expect(getPatStatus(pat({ revokedAt: Date.now() - 1_000 }))).toBe('revoked')
  })

  it('prefers revoked over expired', () => {
    expect(
      getPatStatus(pat({ revokedAt: 1_000, expiresAt: 2_000 })),
    ).toBe('revoked')
  })
})
