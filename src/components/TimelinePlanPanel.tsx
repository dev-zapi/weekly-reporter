'use client'
import { apiFetch } from '@/lib/api-client'

import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Briefcase, LoaderCircle, User } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { PLAN_ITEM_STATUS_COLORS, PLAN_ITEM_STATUS_LABELS } from '@/lib/plan-item-display'
import type { PeriodPlan, PeriodPlanItem } from '@/lib/db/schema'

type ApiResponse = {
  plan: PeriodPlan | null
  items: PeriodPlanItem[]
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
    <Badge className={PLAN_ITEM_STATUS_COLORS[status]}>
      {PLAN_ITEM_STATUS_LABELS[status]}
    </Badge>
  )
}

export function TimelinePlanPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const today = format(new Date(), 'yyyy-MM-dd')
    const url = `/api/plans?scope=week&date=${today}`

    void apiFetch(url, { signal: controller.signal })
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
    <Card role="region" aria-label="Timeline plan table">
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
                      <Badge variant="outline" className="font-mono text-xs">%{item.id}</Badge>
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
