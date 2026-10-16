import { describe, it, expect } from 'vitest'
import { getWeekPeriodRange, getMonthPeriodRange, getMonthPeriodRangeByKey } from './periods'

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
