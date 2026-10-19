import { PeriodPlanManager } from '@/components/PeriodPlanManager'
import { resolvePlansDeepLink } from '@/lib/plan-period-link'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function PlansPage({ searchParams }: { searchParams: SearchParams }) {
  // Deep link from the timeline reference preview card:
  // /plans?scope=<week|month>&start=<periodStart>
  const { scope, start } = resolvePlansDeepLink(await searchParams)

  return (
    <main className="container mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">Period Plans</h1>
      <PeriodPlanManager initialScope={scope} initialStart={start} />
    </main>
  )
}
