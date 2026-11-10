import { describe, it, expect } from 'vitest'
import { toBrowserOffsetInstant } from './time-format'

// The wire form: an RFC3339 instant with an explicit ±HH:MM offset, never a
// UTC `Z` (which would shift an east-of-UTC zero point to the previous day).
const WIRE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

function expectedOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const absolute = Math.abs(minutes)
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0')
  const mm = String(absolute % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

describe('toBrowserOffsetInstant', () => {
  it('renders a local Date with its own offset, never a Z', () => {
    const date = new Date(2026, 10, 3, 0, 0, 0)
    const result = toBrowserOffsetInstant(date)

    expect(result).toMatch(WIRE_RE)
    expect(result).not.toMatch(/Z$/)
    expect(result.endsWith(expectedOffset(date))).toBe(true)
    // Round-trips to the same instant as the local input.
    expect(new Date(result).getTime()).toBe(date.getTime())
  })

  it('keeps the wall clock and includes seconds', () => {
    const result = toBrowserOffsetInstant(new Date(2026, 10, 3, 14, 30, 5))

    expect(result).toMatch(/^2026-11-03T14:30:05[+-]\d{2}:\d{2}$/)
  })
})
