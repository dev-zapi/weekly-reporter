import { describe, it, expect } from 'vitest'
import {
  getWeekPeriodRange,
  getMonthPeriodRange,
  getMonthPeriodRangeByKey,
  getNextWeekPeriodRange,
  getNextMonthPeriodRange,
  toOffsetInstant,
  dateOnlyToOffsetInstant,
  monthKeyToOffsetInstant,
} from './periods'

describe('toOffsetInstant', () => {
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

  it('renders a local Date with its own offset, never a Z', () => {
    const date = new Date(2026, 10, 3, 0, 0, 0)
    const result = toOffsetInstant(date)

    expect(result).toMatch(WIRE_RE)
    expect(result).not.toMatch(/Z$/)
    expect(result.endsWith(expectedOffset(date))).toBe(true)
    // Round-trips to the same instant as the local input.
    expect(new Date(result).getTime()).toBe(date.getTime())
  })

  it('expands a date-only key to local midnight with the browser offset', () => {
    const result = dateOnlyToOffsetInstant('2026-11-03')

    expect(result).toMatch(WIRE_RE)
    const parsed = new Date(result)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(10)
    expect(parsed.getDate()).toBe(3)
    expect(parsed.getHours()).toBe(0)
    expect(parsed.getMinutes()).toBe(0)
    expect(parsed.getSeconds()).toBe(0)
  })

  it('expands a month key to the first day at local midnight', () => {
    const result = monthKeyToOffsetInstant('2026-11')

    expect(result).toMatch(WIRE_RE)
    const parsed = new Date(result)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(10)
    expect(parsed.getDate()).toBe(1)
    expect(parsed.getHours()).toBe(0)
  })
})

describe('getWeekPeriodRange', () => {
  it('should return Monday-start week range as yyyy-MM-dd strings', () => {
    // Wednesday 2026-10-14
    const date = new Date(2026, 9, 14)
    const result = getWeekPeriodRange(date)
    expect(result).toEqual({
      start: '2026-10-12', // Monday
      end: '2026-10-18', // Sunday
    })
  })

  it('should handle Monday correctly', () => {
    // Monday 2026-10-12
    const date = new Date(2026, 9, 12)
    const result = getWeekPeriodRange(date)
    expect(result).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    })
  })

  it('should handle Sunday correctly', () => {
    // Sunday 2026-10-18
    const date = new Date(2026, 9, 18)
    const result = getWeekPeriodRange(date)
    expect(result).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    })
  })

  it('should handle month boundaries', () => {
    // Friday 2026-10-02 (week starts Sep 28)
    const date = new Date(2026, 9, 2)
    const result = getWeekPeriodRange(date)
    expect(result).toEqual({
      start: '2026-09-28', // Monday Sep 28
      end: '2026-10-04', // Sunday Oct 4
    })
  })
})

describe('getMonthPeriodRange', () => {
  it('should return month key and range for a date', () => {
    const date = new Date(2026, 9, 14) // Oct 14, 2026
    const result = getMonthPeriodRange(date)
    expect(result).toEqual({
      monthKey: '2026-10',
      start: '2026-10-01',
      end: '2026-10-31',
    })
  })

  it('should handle February in non-leap year', () => {
    const date = new Date(2025, 1, 15) // Feb 15, 2025
    const result = getMonthPeriodRange(date)
    expect(result).toEqual({
      monthKey: '2025-02',
      start: '2025-02-01',
      end: '2025-02-28',
    })
  })

  it('should handle February in leap year', () => {
    const date = new Date(2024, 1, 15) // Feb 15, 2024
    const result = getMonthPeriodRange(date)
    expect(result).toEqual({
      monthKey: '2024-02',
      start: '2024-02-01',
      end: '2024-02-29',
    })
  })

  it('should handle December', () => {
    const date = new Date(2026, 11, 25) // Dec 25, 2026
    const result = getMonthPeriodRange(date)
    expect(result).toEqual({
      monthKey: '2026-12',
      start: '2026-12-01',
      end: '2026-12-31',
    })
  })
})

describe('getMonthPeriodRangeByKey', () => {
  it('should return range for a month key', () => {
    const result = getMonthPeriodRangeByKey('2026-10')
    expect(result).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    })
  })

  it('should handle February in non-leap year', () => {
    const result = getMonthPeriodRangeByKey('2025-02')
    expect(result).toEqual({
      start: '2025-02-01',
      end: '2025-02-28',
    })
  })

  it('should handle February in leap year', () => {
    const result = getMonthPeriodRangeByKey('2024-02')
    expect(result).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    })
  })

  it('should handle December', () => {
    const result = getMonthPeriodRangeByKey('2026-12')
    expect(result).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    })
  })

  it('should handle January', () => {
    const result = getMonthPeriodRangeByKey('2026-01')
    expect(result).toEqual({
      start: '2026-01-01',
      end: '2026-01-31',
    })
  })
})

describe('getNextWeekPeriodRange', () => {
  it('should return the Monday-start week after the given week start', () => {
    const result = getNextWeekPeriodRange('2026-10-12')
    expect(result).toEqual({
      start: '2026-10-19',
      end: '2026-10-25',
    })
  })

  it('should roll over a year boundary', () => {
    const result = getNextWeekPeriodRange('2026-12-28')
    expect(result).toEqual({
      start: '2027-01-04',
      end: '2027-01-10',
    })
  })
})

describe('getNextMonthPeriodRange', () => {
  it('should return the calendar month after the given month key', () => {
    const result = getNextMonthPeriodRange('2026-10')
    expect(result).toEqual({
      monthKey: '2026-11',
      start: '2026-11-01',
      end: '2026-11-30',
    })
  })

  it('should roll over a year boundary', () => {
    const result = getNextMonthPeriodRange('2026-12')
    expect(result).toEqual({
      monthKey: '2027-01',
      start: '2027-01-01',
      end: '2027-01-31',
    })
  })

  it('should handle February in a leap year', () => {
    const result = getNextMonthPeriodRange('2024-01')
    expect(result).toEqual({
      monthKey: '2024-02',
      start: '2024-02-01',
      end: '2024-02-29',
    })
  })
})
