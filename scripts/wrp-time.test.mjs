// Unit tests for the wrp time-zone utility (#136).
//
// These hit the module's public functions directly: strict instant parsing,
// system-zone formatting with explicit offsets, and date-to-UTC expansion.
// The CLI-level behaviour (which lines an agent sees) is covered by the module
// suites; here the optional `timeZone` argument pins the zone so the assertions
// do not depend on the host machine.

import { describe, it, expect } from 'vitest'

import {
  detectSystemTimeZone,
  formatInstant,
  localDateToUtcMillis,
  naiveInstantWithOffset,
  parseStrictInstant,
} from '../skills/weekly-reporter/scripts/lib/time.mjs'

describe('parseStrictInstant', () => {
  it('accepts an explicit offset and returns the absolute instant', () => {
    const parsed = parseStrictInstant('2026-11-10T09:00:00+08:00')
    expect(parsed.ok).toBe(true)
    expect(parsed.epochMillis).toBe(Date.parse('2026-11-10T01:00:00Z'))
  })

  it('accepts Z and a secondless HH:MM time', () => {
    const parsed = parseStrictInstant('2026-11-10T09:00Z')
    expect(parsed.ok).toBe(true)
    expect(parsed.epochMillis).toBe(Date.parse('2026-11-10T09:00:00Z'))
  })

  it('accepts optional seconds and milliseconds', () => {
    const parsed = parseStrictInstant('2026-11-10T09:00:00.123-05:00')
    expect(parsed.ok).toBe(true)
    expect(parsed.epochMillis).toBe(Date.parse('2026-11-10T14:00:00.123Z'))
  })

  it('rejects a naive timestamp as missing its offset', () => {
    expect(parseStrictInstant('2026-11-10T09:00')).toEqual({
      ok: false,
      reason: 'missing-offset',
    })
  })

  it('rejects a calendar date Date would silently roll over', () => {
    expect(parseStrictInstant('2026-11-31T09:00:00Z')).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('rejects a space separator and a date-only value', () => {
    expect(parseStrictInstant('2026-11-10 09:00:00Z').ok).toBe(false)
    expect(parseStrictInstant('2026-11-10').ok).toBe(false)
  })
})

describe('formatInstant', () => {
  it('renders the system zone with an explicit offset, seconds included', () => {
    expect(formatInstant('2026-11-09T14:02:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-11-09T22:02:00+08:00',
    )
  })

  it('renders UTC with a +00:00 offset rather than Z', () => {
    expect(formatInstant('2026-11-09T14:02:00.000Z', 'UTC')).toBe('2026-11-09T14:02:00+00:00')
  })

  it('uses the offset in effect at that instant (DST both ways)', () => {
    expect(formatInstant('2026-01-15T05:00:00Z', 'America/New_York')).toBe(
      '2026-01-15T00:00:00-05:00',
    )
    expect(formatInstant('2026-07-15T05:00:00Z', 'America/New_York')).toBe(
      '2026-07-15T01:00:00-04:00',
    )
  })

  it('returns null for a missing or unparseable value', () => {
    expect(formatInstant(null, 'UTC')).toBeNull()
    expect(formatInstant('not-a-date', 'UTC')).toBeNull()
  })
})

describe('localDateToUtcMillis', () => {
  it('expands a date to midnight in the given zone', () => {
    expect(localDateToUtcMillis('2026-11-10', 'Asia/Shanghai')).toBe(
      Date.parse('2026-11-09T16:00:00Z'),
    )
  })

  it('follows the DST offset on each side of the transition', () => {
    expect(localDateToUtcMillis('2026-03-08', 'America/New_York')).toBe(
      Date.parse('2026-03-08T05:00:00Z'),
    )
    expect(localDateToUtcMillis('2026-03-09', 'America/New_York')).toBe(
      Date.parse('2026-03-09T04:00:00Z'),
    )
  })

  it('rejects an invalid calendar date and a malformed value', () => {
    expect(localDateToUtcMillis('2026-11-31', 'UTC')).toBeNull()
    expect(localDateToUtcMillis('2026/11/10', 'UTC')).toBeNull()
  })
})

describe('naiveInstantWithOffset', () => {
  it('appends the zone offset for the same wall-clock time', () => {
    expect(naiveInstantWithOffset('2026-11-10T09:00', 'Asia/Shanghai')).toBe(
      '2026-11-10T09:00:00+08:00',
    )
  })

  it('returns null when the value is not a naive instant', () => {
    expect(naiveInstantWithOffset('2026-11-10T09:00:00Z', 'UTC')).toBeNull()
  })
})

describe('detectSystemTimeZone', () => {
  it('reports the TZ the process runs under', () => {
    expect(detectSystemTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
