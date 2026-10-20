import { describe, it, expect } from 'vitest'
import { randomBase62 } from './random'

describe('randomBase62', () => {
  it('returns a string of the requested length', () => {
    expect(randomBase62(0)).toBe('')
    expect(randomBase62(1)).toHaveLength(1)
    expect(randomBase62(48)).toHaveLength(48)
  })

  it('uses only base62 characters', () => {
    expect(randomBase62(256)).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('produces different values on each call', () => {
    const values = new Set(Array.from({ length: 50 }, () => randomBase62(32)))

    expect(values.size).toBe(50)
  })
})
