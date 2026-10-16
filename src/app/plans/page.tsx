'use client'

import { PeriodPlanManager } from '@/components/PeriodPlanManager'

export default function PlansPage() {
  return (
    <main className="container mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">Period Plans</h1>
      <PeriodPlanManager />
    </main>
  )
}
