'use client'

import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Briefcase, LoaderCircle, User } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { PeriodPlanItem } from '@/lib/db/schema'

type PeriodPlan = {
  id: number
  scope: 'week'
  periodStart: string
  periodEnd: string
}

type ApiResponse = {
  plan: PeriodPlan | null
  items: PeriodPlanItem[]
}

const statusLabels: Record<PeriodPlanItem['status'], string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
  deferred: 'Deferred',
}

const statusColors: Record<PeriodPlanItem['status'], string> = {
  planned: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  deferred: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
}

function ProjectScopeBadge({ scope }: { scope: PeriodPlanItem['projectScope'] }) {
  const Icon = scope === 'personal' ? User : Briefcase
  return (
    <Badge variant="outline" className="gap-1">
      <Icon className="h-3 w-3" />
      {scope === 'personal' ? 'Personal' : 'Work'}
    </Badge>
  )
}

function StatusBadge({ status }: { status: PeriodPlanItem['status'] }) {
  return (
    <Badge className={statusColors[status]}>
      {statusLabels[status]}
    </Badge>
  )
}

export function CurrentWeekPlanPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const today = format(new Date(), 'yyyy-MM-dd')
    const url = `/api/plans?scope=week&date=${today}`

    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ApiResponse & { error?: string }
        if (!response.ok) throw new Error(payload.error || 'Failed to load plan')
        setData(payload)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Failed to load plan')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [refreshKey])

  return (
    <Card role="region" aria-label="Current week plan">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>This Week&apos;s Plan</span>
          <Link
            href="/plans"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          >
            Manage Plans
          </Link>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Read-only projection of current week&apos;s period plan
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div role="alert" className="py-3 text-sm text-destructive">{error}</div>
        ) : !data || data.items.length === 0 ? (
          <div className="space-y-3 py-3">
            <div className="text-sm text-muted-foreground">
              No plan yet for this week.
            </div>
            <Link
              href="/plans"
              className={cn(buttonVariants({ size: 'sm' }))}
            >
              Create Plan
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-2">
              {data.items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-sm">
                  <div className="flex-1 space-y-1">
                    <div className="font-medium">{item.text}</div>
                    <div className="flex flex-wrap gap-1.5">
                      <StatusBadge status={item.status} />
                      <ProjectScopeBadge scope={item.projectScope} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="pt-2 border-t">
              <Link
                href="/plans"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}
              >
                View All Plans
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
