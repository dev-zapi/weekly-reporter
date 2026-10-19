import { describe, expect, it } from 'vitest'
import { buildPlansDeepLink } from './plan-links'

describe('buildPlansDeepLink', () => {
  it('builds a week deep link with the period start', () => {
    expect(buildPlansDeepLink('week', '2026-10-19')).toBe('/plans?scope=week&start=2026-10-19')
  })

  it('builds a month deep link with the period start', () => {
    expect(buildPlansDeepLink('month', '2026-10-01')).toBe('/plans?scope=month&start=2026-10-01')
  })
})
