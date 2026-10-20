import type { PeriodPlanScope } from '@/lib/db/schema'

/**
 * Deep-link contract between the event-side plan-item preview card and the
 * /plans page: `/plans?scope=<week|month>&start=<periodStart>`, where
 * periodStart is the period plan's `periodStart` value (YYYY-MM-DD).
 *
 * `buildPlansDeepLink` emits the link; `resolvePlansDeepLink` parses it back.
 * Unknown scopes fall back to week, and a malformed or missing start falls back
 * to the current period (null).
 */
export type PlansDeepLink = {
  scope: PeriodPlanScope
  start: string | null
}

// Same shape the plans API accepts for a period start date.
const PERIOD_START_REGEX = /^\d{4}-\d{2}-\d{2}$/

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function buildPlansDeepLink(scope: PeriodPlanScope, periodStart: string): string {
  const params = new URLSearchParams({ scope, start: periodStart })
  return `/plans?${params.toString()}`
}

export function resolvePlansDeepLink(params: {
  scope?: string | string[]
  start?: string | string[]
}): PlansDeepLink {
  const rawScope = firstValue(params.scope)
  const rawStart = firstValue(params.start)
  const scope: PeriodPlanScope = rawScope === 'month' ? 'month' : 'week'
  const start = typeof rawStart === 'string' && PERIOD_START_REGEX.test(rawStart) ? rawStart : null
  return { scope, start }
}
