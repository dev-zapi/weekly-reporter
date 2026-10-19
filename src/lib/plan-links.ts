// Deep link from a plan-item preview into the /plans page, carrying the period
// so the consuming side can jump to the owning plan.
//
// Contract (shared with the plans page): `/plans?scope=<week|month>&start=<periodStart>`
// where periodStart is the period plan's `periodStart` value (YYYY-MM-DD).
export type PlansScope = 'week' | 'month'

export function buildPlansDeepLink(scope: PlansScope, periodStart: string): string {
  const params = new URLSearchParams({ scope, start: periodStart })
  return `/plans?${params.toString()}`
}
