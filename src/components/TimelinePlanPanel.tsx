'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Briefcase, LoaderCircle, User } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  PLAN_ITEM_STATUS_COLORS,
  PLAN_ITEM_STATUS_ICONS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUS_ORDER,
} from '@/lib/plan-item-display'
import type { PeriodPlan, PeriodPlanItem, PeriodPlanItemStatus } from '@/lib/db/schema'

type ApiResponse = {
  plan: PeriodPlan | null
  items: PeriodPlanItem[]
}

const DEFAULT_STATUS_FILTER: PeriodPlanItemStatus[] = ['planned', 'in_progress']

type IconBadgeProps = {
  Icon: LucideIcon
  label: string
  className?: string
  /** Constrained to the two variants this helper actually renders. */
  variant?: 'default' | 'outline'
}

/**
 * A focusable, icon-only tooltip trigger. role="img" makes aria-label naming
 * valid on this non-interactive display element; tabIndex gives native
 * keyboard focus and lets the Tooltip primitive handle hover/focus uniformly.
 */
function IconBadge({ Icon, label, className, variant }: IconBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={variant}
            className={cn('gap-1 align-middle', className)}
            role="img"
            tabIndex={0}
            aria-label={label}
          />
        }
      >
        <Icon className="h-3 w-3" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ProjectScopeBadge({ scope }: { scope: PeriodPlanItem['projectScope'] }) {
  const Icon = scope === 'personal' ? User : Briefcase
  return (
    <IconBadge
      Icon={Icon}
      label={`Project scope: ${scope === 'personal' ? 'Personal' : 'Work'}`}
      variant="outline"
    />
  )
}

function StatusBadge({ status }: { status: PeriodPlanItemStatus }) {
  return (
    <IconBadge
      Icon={PLAN_ITEM_STATUS_ICONS[status]}
      label={`Status: ${PLAN_ITEM_STATUS_LABELS[status]}`}
      className={PLAN_ITEM_STATUS_COLORS[status]}
    />
  )
}

function StatusFilter({
  selected,
  onToggle,
}: {
  selected: PeriodPlanItemStatus[]
  onToggle: (status: PeriodPlanItemStatus) => void
}) {
  return (
    <div role="group" aria-label="Filter plan items by status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b pb-3">
      {PLAN_ITEM_STATUS_ORDER.map((status) => {
        const Icon = PLAN_ITEM_STATUS_ICONS[status]
        return (
          <label key={status} className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Checkbox
              checked={selected.includes(status)}
              onCheckedChange={() => onToggle(status)}
            />
            <Icon className="h-3 w-3" aria-hidden="true" />
            <span>{PLAN_ITEM_STATUS_LABELS[status]}</span>
          </label>
        )
      })}
    </div>
  )
}

export function TimelinePlanPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Status selection is panel-local and survives refetches; a full mount resets it.
  const [selectedStatuses, setSelectedStatuses] = useState<PeriodPlanItemStatus[]>(DEFAULT_STATUS_FILTER)

  useEffect(() => {
    const controller = new AbortController()
    const today = format(new Date(), 'yyyy-MM-dd')
    const url = `/api/plans?scope=week&date=${today}`

    void apiFetch(url, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ApiResponse & { error?: string }
        if (!response.ok) throw new Error((payload.error || 'Failed to load plan') + traceSuffix(response))
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

  const toggleStatus = (status: PeriodPlanItemStatus) => {
    setSelectedStatuses((previous) => {
      const next = previous.includes(status)
        ? previous.filter((value) => value !== status)
        : [...previous, status]
      // Keep shared display order regardless of click order.
      return PLAN_ITEM_STATUS_ORDER.filter((value) => next.includes(value))
    })
  }

  // An empty selection means "no status filter applied" rather than "show nothing".
  const visibleItems = !data
    ? []
    : selectedStatuses.length === 0
      ? data.items
      : data.items.filter((item) => selectedStatuses.includes(item.status))
  const hasItemsButNoFilterMatches = !!data && data.items.length > 0 && visibleItems.length === 0

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
            <StatusFilter selected={selectedStatuses} onToggle={toggleStatus} />
            {hasItemsButNoFilterMatches ? (
              <div className="py-3 text-sm text-muted-foreground">
                No plan items match this filter.
              </div>
            ) : (
              <ul className="space-y-2">
                {visibleItems.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 text-sm">
                    <Badge variant="outline" className="shrink-0 font-mono text-xs">%{item.id}</Badge>
                    <div className="flex-1 font-medium">
                      {item.text}{' '}
                      <StatusBadge status={item.status} />
                      {' '}
                      <ProjectScopeBadge scope={item.projectScope} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="pt-2">
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
