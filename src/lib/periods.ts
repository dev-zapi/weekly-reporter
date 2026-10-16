import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns'

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
