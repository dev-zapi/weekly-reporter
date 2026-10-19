/** Deep-link contract for the /plans page: `?scope=<week|month>&start=<periodStart>`. */
export type PlanScope = 'week' | 'month'

export type PlansDeepLink = {
  scope: PlanScope
  start: string | null
}

// Same shape the plans API accepts for a period start date.
const PERIOD_START_REGEX = /^\d{4}-\d{2}-\d{2}$/

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Resolve the /plans deep-link query params emitted by the event-side preview
 * card into the period the page should open. Unknown scopes fall back to week;
 * a malformed or missing start falls back to the current period (null).
 */
export function resolvePlansDeepLink(params: {
  scope?: string | string[]
  start?: string | string[]
}): PlansDeepLink {
  const rawScope = firstValue(params.scope)
  const rawStart = firstValue(params.start)
  const scope: PlanScope = rawScope === 'month' ? 'month' : 'week'
  const start = typeof rawStart === 'string' && PERIOD_START_REGEX.test(rawStart) ? rawStart : null
  return { scope, start }
}
