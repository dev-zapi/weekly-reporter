import { PeriodPlanManager } from '@/components/PeriodPlanManager'
import { resolvePlansDeepLink } from '@/lib/plan-links'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function PlansPage({ searchParams }: { searchParams: SearchParams }) {
  // Deep link from the timeline reference preview card or the event-side
  // cited-by marker: /plans?scope=<week|month>&start=<periodStart>[&item=<id>]
  const { scope, start, item } = resolvePlansDeepLink(await searchParams)

  // The manager owns the full Numbered Evidence split surface: a title-first
  // primary column and a persistent context rail, with no body-level top bar.
  return <PeriodPlanManager initialScope={scope} initialStart={start} initialItemId={item} />
}
