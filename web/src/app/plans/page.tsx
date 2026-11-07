import { useSearchParams } from 'react-router'
import { PeriodPlanManager } from '@/components/PeriodPlanManager'
import { resolvePlansDeepLink } from '@/lib/plan-links'

/**
 * Plans page — the SPA counterpart of the Next server component.
 *
 * Deep link from the timeline reference preview card or the event-side
 * cited-by marker: /plans?scope=<week|month>&start=<periodStart>[&item=<id>]
 *
 * The Next version received `searchParams` from the server and handed the
 * resolved values to the manager as initial props. Here the same parsing runs
 * in the client; props are initial values only, exactly like the server
 * version (the manager keeps its own state across same-route navigations, and
 * its initialItemId effect still reacts to a deep link change).
 */
export default function PlansPage() {
  const [searchParams] = useSearchParams()
  const { scope, start, item } = resolvePlansDeepLink({
    scope: searchParams.get('scope') ?? undefined,
    start: searchParams.get('start') ?? undefined,
    item: searchParams.get('item') ?? undefined,
  })

  // The manager owns the full Numbered Evidence split surface: a title-first
  // primary column and a persistent context rail, with no body-level top bar.
  return (
    <PeriodPlanManager
      initialScope={scope}
      initialStart={start}
      initialItemId={item}
    />
  )
}
