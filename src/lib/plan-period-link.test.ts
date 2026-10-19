import { describe, it, expect } from 'vitest'
import { resolvePlansDeepLink } from './plan-period-link'

describe('resolvePlansDeepLink', () => {
  it('reads a scope and period start from the query params', () => {
    expect(resolvePlansDeepLink({ scope: 'month', start: '2026-03-01' })).toEqual({
      scope: 'month',
      start: '2026-03-01',
    })
  })

  it('defaults to week scope when scope is missing or unknown', () => {
    expect(resolvePlansDeepLink({ start: '2026-10-12' })).toEqual({
      scope: 'week',
      start: '2026-10-12',
    })
    expect(resolvePlansDeepLink({ scope: 'quarter', start: '2026-10-12' }).scope).toBe('week')
  })

  it('ignores a malformed period start', () => {
    expect(resolvePlansDeepLink({ scope: 'week', start: 'not-a-date' })).toEqual({
      scope: 'week',
      start: null,
    })
  })

  it('returns a null start when none is given', () => {
    expect(resolvePlansDeepLink({})).toEqual({ scope: 'week', start: null })
  })

  it('uses the first value of a repeated param', () => {
    expect(
      resolvePlansDeepLink({ scope: ['month', 'week'], start: ['2026-03-01', '2026-04-01'] }),
    ).toEqual({ scope: 'month', start: '2026-03-01' })
  })
})
