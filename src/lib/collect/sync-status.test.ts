import { describe, expect, it } from 'vitest'
import { SYNC_FAILED_STATUSES, isSyncFailure } from './sync-status'

describe('sync status vocabulary', () => {
  it('accepts both the stored and the client-facing failure spellings', () => {
    expect(SYNC_FAILED_STATUSES).toEqual(['failed', 'failure'])
    expect(isSyncFailure('failed')).toBe(true)
    expect(isSyncFailure('failure')).toBe(true)
  })

  it('does not treat success, null, or unknown values as failure', () => {
    expect(isSyncFailure('success')).toBe(false)
    expect(isSyncFailure(null)).toBe(false)
    expect(isSyncFailure(undefined)).toBe(false)
  })
})
