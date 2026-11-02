import { describe, it, expect } from 'vitest'
import { buildPlansDeepLink, resolvePlansDeepLink } from './plan-links'

describe('buildPlansDeepLink', () => {
  it('builds a week deep link with the period start', () => {
    expect(buildPlansDeepLink('week', '2026-10-19')).toBe('/plans?scope=week&start=2026-10-19')
  })

  it('builds a month deep link with the period start', () => {
    expect(buildPlansDeepLink('month', '2026-10-01')).toBe('/plans?scope=month&start=2026-10-01')
  })

  it('includes the item id when locating a specific item', () => {
    expect(buildPlansDeepLink('week', '2026-10-19', 7)).toBe(
      '/plans?scope=week&start=2026-10-19&item=7',
    )
  })
})

describe('resolvePlansDeepLink', () => {
  it('reads a scope and period start from the query params', () => {
    expect(resolvePlansDeepLink({ scope: 'month', start: '2026-03-01' })).toEqual({
      scope: 'month',
      start: '2026-03-01',
      item: null,
    })
  })

  it('reads an item id for an adjusted item deep link', () => {
    expect(resolvePlansDeepLink({ scope: 'week', start: '2026-10-12', item: '42' })).toEqual({
      scope: 'week',
      start: '2026-10-12',
      item: 42,
    })
  })

  it('ignores a malformed item id', () => {
    expect(resolvePlansDeepLink({ scope: 'week', start: '2026-10-12', item: 'abc' }).item).toBeNull()
    expect(resolvePlansDeepLink({ scope: 'week', start: '2026-10-12', item: '-3' }).item).toBeNull()
    expect(resolvePlansDeepLink({ scope: 'week', start: '2026-10-12', item: '0' }).item).toBeNull()
  })

  it('defaults to week scope when scope is missing or unknown', () => {
    expect(resolvePlansDeepLink({ start: '2026-10-12' })).toEqual({
      scope: 'week',
      start: '2026-10-12',
      item: null,
    })
    expect(resolvePlansDeepLink({ scope: 'quarter', start: '2026-10-12' }).scope).toBe('week')
  })

  it('ignores a malformed period start', () => {
    expect(resolvePlansDeepLink({ scope: 'week', start: 'not-a-date' })).toEqual({
      scope: 'week',
      start: null,
      item: null,
    })
  })

  it('returns a null start when none is given', () => {
    expect(resolvePlansDeepLink({})).toEqual({ scope: 'week', start: null, item: null })
  })

  it('uses the first value of a repeated param', () => {
    expect(
      resolvePlansDeepLink({ scope: ['month', 'week'], start: ['2026-03-01', '2026-04-01'] }),
    ).toEqual({
      scope: 'month',
      start: '2026-03-01',
      item: null,
    })
  })
})
