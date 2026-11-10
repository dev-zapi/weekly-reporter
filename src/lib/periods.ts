import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, addWeeks, addMonths } from 'date-fns'

/**
 * Render a local Date as an RFC3339 instant carrying the browser's own offset
 * (`2026-11-03T00:00:00+08:00`). The plans wire only accepts offset instants,
 * and the server reads the calendar in the request's offset — so the offset
 * must be preserved, never folded to UTC `Z` (which would move an east-of-UTC
 * zero point to the previous day). Lowercase `xxx` never emits `Z`.
 */
export function toOffsetInstant(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm:ssxxx")
}

/** A yyyy-MM-dd period key → that day's local midnight, as an offset instant. */
export function dateOnlyToOffsetInstant(dateString: string): string {
  return toOffsetInstant(new Date(`${dateString}T00:00:00`))
}

/** A yyyy-MM month key → that month's local midnight start, as an offset instant. */
export function monthKeyToOffsetInstant(monthKey: string): string {
  return toOffsetInstant(new Date(`${monthKey}-01T00:00:00`))
}

/**
 * Returns the Monday-start week range for a given date as yyyy-MM-dd strings.
 */
export function getWeekPeriodRange(date: Date): { start: string; end: string } {
  const start = startOfWeek(date, { weekStartsOn: 1 })
  const end = endOfWeek(date, { weekStartsOn: 1 })
  return {
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
  }
}

/**
 * Returns the calendar month range for a given date, including the monthKey.
 */
export function getMonthPeriodRange(date: Date): { monthKey: string; start: string; end: string } {
  const monthKey = format(date, 'yyyy-MM')
  const start = startOfMonth(date)
  const end = endOfMonth(date)
  return {
    monthKey,
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
  }
}

/**
 * Returns the calendar month range for a given monthKey (yyyy-MM format).
 */
export function getMonthPeriodRangeByKey(monthKey: string): { start: string; end: string } {
  // Parse yyyy-MM to create a date in that month
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(year, month - 1, 1)
  const start = startOfMonth(date)
  const end = endOfMonth(date)
  return {
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
  }
}

/**
 * Returns the Monday-start week range immediately following the given week
 * start date (yyyy-MM-dd), as yyyy-MM-dd strings.
 */
export function getNextWeekPeriodRange(weekStart: string): { start: string; end: string } {
  const [year, month, day] = weekStart.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return getWeekPeriodRange(addWeeks(date, 1))
}

/**
 * Returns the calendar month immediately following the given monthKey
 * (yyyy-MM), including its derived monthKey and range.
 */
export function getNextMonthPeriodRange(monthKey: string): { monthKey: string; start: string; end: string } {
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(year, month - 1, 1)
  return getMonthPeriodRange(addMonths(date, 1))
}
