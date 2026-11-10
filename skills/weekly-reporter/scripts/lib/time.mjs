// Zero-dependency time-zone helpers for the wrp client (#136).
//
// Everything runs on Node's built-in Intl (full-ICU, Node >= 18): the system
// zone comes from TZ/ICU rather than a hard-coded offset, so daylight-saving
// transitions are ICU's job, not ours.
//
// Two directions:
//   - parseStrictInstant turns an absolute instant into epoch millis. An input
//     without `Z` or `±HH:MM` is not an instant, and a calendar date Date would
//     silently roll over (2026-11-31) is rejected instead of coerced.
//   - formatInstant renders an instant in the system zone as ISO with an
//     explicit offset and seconds (`2026-11-10T14:30:00+08:00`).
//
// Date-only period keys (the wire still speaks YYYY-MM-DD) expand to midnight
// in the system zone and convert to UTC, ready for the wire-cutover tickets.

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const formatters = new Map()

/** The IANA zone the process runs under (`TZ` env, else the OS setting). */
export function detectSystemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** The wall-clock components `timeZone` shows at that absolute instant. */
function partsAt(epochMillis, timeZone) {
  const values = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMillis))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

/** Offset of `timeZone` at that instant, in minutes east of UTC. */
export function utcOffsetMinutes(epochMillis, timeZone = detectSystemTimeZone()) {
  const parts = partsAt(epochMillis, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const truncated = Math.floor(epochMillis / 1000) * 1000
  return Math.round((asUtc - truncated) / 60000)
}

/** `480` → `+08:00`, `-300` → `-05:00`. */
export function formatOffset(minutes) {
  const sign = minutes >= 0 ? '+' : '-'
  const absolute = Math.abs(minutes)
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function validCalendarDate({ year, month, day }) {
  if (month < 1 || month > 12) return false
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  return day >= 1 && day <= limit
}

function validTimeOfDay({ hour, minute, second }) {
  return hour <= 23 && minute <= 59 && second <= 59
}

function fractionMillis(fraction) {
  return fraction === undefined ? 0 : Number(String(fraction).padEnd(3, '0'))
}

function offsetMinutes(text) {
  if (text === 'Z') return 0
  const hours = Number(text.slice(1, 3))
  const minutes = Number(text.slice(4, 6))
  if (hours > 23 || minutes > 59) return null
  const total = hours * 60 + minutes
  return text[0] === '-' ? -total : total
}

/** Naive `YYYY-MM-DDTHH:mm[:ss[.mmm]]` → components, or null. */
function parseNaive(value) {
  if (typeof value !== 'string') return null
  const match = NAIVE_RE.exec(value)
  if (!match) return null
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    fraction: fractionMillis(match[7]),
  }
  if (!validCalendarDate(parts) || !validTimeOfDay(parts)) return null
  return parts
}

/** Treat a wall-clock reading as local time in `timeZone` and return UTC millis. */
function wallClockToUtcMillis(parts, timeZone) {
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.fraction,
  )
  // Read the wall clock as UTC, correct by the zone offset there, then correct
  // once more so a DST transition between the two guesses is followed.
  let epochMillis = wall - utcOffsetMinutes(wall, timeZone) * 60000
  epochMillis = wall - utcOffsetMinutes(epochMillis, timeZone) * 60000
  return epochMillis
}

/**
 * Parse an absolute instant. The input must carry `Z` or `±HH:MM`; returns
 * `{ ok: true, epochMillis }` or `{ ok: false, reason: 'missing-offset'|'invalid' }`.
 */
export function parseStrictInstant(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' }
  const match = INSTANT_RE.exec(value)
  if (!match) {
    // A well-formed naive timestamp is a distinct, common mistake: name it.
    const naive = NAIVE_RE.exec(value)
    const reason =
      naive &&
      validCalendarDate({
        year: Number(naive[1]),
        month: Number(naive[2]),
        day: Number(naive[3]),
      }) &&
      validTimeOfDay({
        hour: Number(naive[4]),
        minute: Number(naive[5]),
        second: Number(naive[6] ?? 0),
      })
        ? 'missing-offset'
        : 'invalid'
    return { ok: false, reason }
  }

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    fraction: fractionMillis(match[7]),
  }
  const offset = offsetMinutes(match[8])
  if (!validCalendarDate(parts) || !validTimeOfDay(parts) || offset === null) {
    return { ok: false, reason: 'invalid' }
  }

  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.fraction,
  )
  return { ok: true, epochMillis: wall - offset * 60000 }
}

/**
 * Render an instant in `timeZone` as `YYYY-MM-DDTHH:mm:ss±HH:MM`.
 * Returns null for a missing or unparseable value.
 */
export function formatInstant(value, timeZone = detectSystemTimeZone()) {
  if (value === null || value === undefined || value === '') return null
  const epochMillis = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (Number.isNaN(epochMillis)) return null
  const parts = partsAt(epochMillis, timeZone)
  const offset = formatOffset(utcOffsetMinutes(epochMillis, timeZone))
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offset}`
  )
}

/** `YYYY-MM-DD` → UTC millis of midnight in `timeZone`, or null. */
export function localDateToUtcMillis(dateString, timeZone = detectSystemTimeZone()) {
  if (typeof dateString !== 'string') return null
  const match = DATE_RE.exec(dateString)
  if (!match) return null
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  if (!validCalendarDate(parts)) return null
  return wallClockToUtcMillis({ ...parts, hour: 0, minute: 0, second: 0, fraction: 0 }, timeZone)
}

/**
 * `YYYY-MM-DD` → that calendar day's midnight in `timeZone`, rendered with the
 * zone offset (`2026-11-09T00:00:00+08:00`), or null.
 *
 * The offset must stay on the wire: the server rounds the window by the offset
 * the request carries (#135 决策 2), so dropping it to a `.000Z` instant would
 * move a Shanghai day back to the previous UTC day.
 */
export function localDateToOffsetInstant(dateString, timeZone = detectSystemTimeZone()) {
  const epochMillis = localDateToUtcMillis(dateString, timeZone)
  if (epochMillis === null) return null
  return `${dateString}T00:00:00${formatOffset(utcOffsetMinutes(epochMillis, timeZone))}`
}

/**
 * A naive `YYYY-MM-DDTHH:mm[:ss[.mmm]]` → the same wall clock with the zone
 * offset appended (`2026-11-10T09:00:00+08:00`), or null. Used to make a
 * missing-offset error show a copy-pasteable fix.
 */
export function naiveInstantWithOffset(value, timeZone = detectSystemTimeZone()) {
  const parts = parseNaive(value)
  if (!parts) return null
  const epochMillis = wallClockToUtcMillis(parts, timeZone)
  const offset = formatOffset(utcOffsetMinutes(epochMillis, timeZone))
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offset}`
  )
}
