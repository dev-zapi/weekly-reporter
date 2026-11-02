import type { PeriodPlanScope } from '@/lib/db/schema'

/**
 * Deep-link contract between the event-side plan-item preview card and the
 * /plans page: `/plans?scope=<week|month>&start=<periodStart>[&item=<id>]`,
 * where periodStart is the period plan's `periodStart` value (YYYY-MM-DD).
 *
 * `item` is optional: it points at a specific plan item to expand and
 * highlight (used by the event-side cited-by marker, which locates the plan
 * item holding a citing comment). Without it the link only selects a period.
 *
 * `buildPlansDeepLink` emits the link; `resolvePlansDeepLink` parses it back.
 * Unknown scopes fall back to week, and a malformed or missing start falls back
 * to the current period (null).
 */
export type PlansDeepLink = {
  scope: PeriodPlanScope
  start: string | null
  item: number | null
}

// Same shape the plans API accepts for a period start date.
const PERIOD_START_REGEX = /^\d{4}-\d{2}-\d{2}$/

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseItemId(value: string | string[] | undefined): number | null {
  const raw = firstValue(value)
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const id = Number.parseInt(raw, 10)
  return Number.isFinite(id) && id > 0 ? id : null
}

export function buildPlansDeepLink(
  scope: PeriodPlanScope,
  periodStart: string,
  itemId?: number | null,
): string {
  const params = new URLSearchParams({ scope, start: periodStart })
  if (typeof itemId === 'number' && Number.isInteger(itemId) && itemId > 0) {
    params.set('item', String(itemId))
  }
  return `/plans?${params.toString()}`
}

export function resolvePlansDeepLink(params: {
  scope?: string | string[]
  start?: string | string[]
  item?: string | string[]
}): PlansDeepLink {
  const rawScope = firstValue(params.scope)
  const rawStart = firstValue(params.start)
  const scope: PeriodPlanScope = rawScope === 'month' ? 'month' : 'week'
  const start = typeof rawStart === 'string' && PERIOD_START_REGEX.test(rawStart) ? rawStart : null
  return { scope, start, item: parseItemId(params.item) }
}
