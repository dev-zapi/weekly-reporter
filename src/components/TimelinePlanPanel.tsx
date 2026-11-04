'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Briefcase, LoaderCircle, Star, User, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  PLAN_ITEM_PRIORITY_LABELS,
  PLAN_ITEM_PRIORITY_TINTS,
  PLAN_ITEM_STATUS_COLORS,
  PLAN_ITEM_STATUS_ICONS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUS_ORDER,
} from '@/lib/plan-item-display'
import type {
  PeriodPlan,
  PeriodPlanItem,
  PeriodPlanItemPriority,
  PeriodPlanItemStatus,
} from '@/lib/db/schema'
import styles from './timeline.module.css'

/**
 * Priority is always stated in words. The dot repeats the level for scanning;
 * neither cue borrows a warning hue or the theme's error tokens.
 */
function PriorityLabel({ priority }: { priority: PeriodPlanItemPriority }) {
  return (
    <span className={styles.planPriority} data-priority={priority}>
      <span
        aria-hidden="true"
        className={cn('inline-block h-2 w-2 shrink-0 rounded-full', PLAN_ITEM_PRIORITY_TINTS[priority])}
      />
      {PLAN_ITEM_PRIORITY_LABELS[priority]} priority
    </span>
  )
}

/** Important/urgent are icon-only annotations; priority never changes them. */
function ImportantBadge() {
  return (
    <IconBadge
      Icon={Star}
      label="Important"
      className="rounded-[3px] border-[#eccf9c] bg-[#fff3dd] text-[#8a4d05]"
    />
  )
}

function UrgentBadge() {
  return (
    <IconBadge
      Icon={Zap}
      label="Urgent"
      className="rounded-[3px] border-[#e4bcbc] bg-[#fff1f1] text-[#a43b3b]"
    />
  )
}

type ApiResponse = {
  plan: PeriodPlan | null
  items: PeriodPlanItem[]
}

const DEFAULT_STATUS_FILTER: PeriodPlanItemStatus[] = ['planned', 'in_progress']

type IconBadgeProps = {
  Icon: LucideIcon
  label: string
  className?: string
}

/**
 * A focusable, icon-only tooltip trigger. role="img" makes aria-label naming
 * valid on this non-interactive display element; tabIndex gives native
 * keyboard focus and lets the Tooltip primitive handle hover/focus uniformly.
 * A plain span avoids the shared Badge's theme tokens on this fixed-light
 * surface.
 */
function IconBadge({ Icon, label, className }: IconBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(styles.iconBadge, className)}
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
    <div role="group" aria-label="Filter plan items by status" className={styles.planStatusFilter}>
      {PLAN_ITEM_STATUS_ORDER.map((status) => {
        const Icon = PLAN_ITEM_STATUS_ICONS[status]
        return (
          <label key={status} className={styles.planStatusOption}>
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
    <section className={`${styles.panel} ${styles.planPanel}`} role="region" aria-label="Timeline plan table">
      <header className={styles.planPanelHeader}>
        <div className={styles.planPanelTitleRow}>
          <h2 className={styles.panelTitle}>This Week&apos;s Plan</h2>
          <Link href="/plans" className={styles.textButton}>
            Manage Plans
          </Link>
        </div>
        <p className={styles.panelCopy}>
          Read-only projection of current week&apos;s period plan
        </p>
      </header>
      <div className={styles.planPanelBody}>
        {loading ? (
          <div role="status" className={styles.planLoading}>
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div role="alert" className={styles.planError}>{error}</div>
        ) : !data || data.items.length === 0 ? (
          <div className={styles.planEmpty}>
            <div className={styles.planMuted}>
              No plan yet for this week.
            </div>
            <Link href="/plans" className={styles.primaryButton}>
              Create Plan
            </Link>
          </div>
        ) : (
          <div className={styles.planListSection}>
            <StatusFilter selected={selectedStatuses} onToggle={toggleStatus} />
            {hasItemsButNoFilterMatches ? (
              <div className={styles.planMuted}>
                No plan items match this filter.
              </div>
            ) : (
              <ul className={styles.planList}>
                {visibleItems.map((item) => (
                  <li
                    key={item.id}
                    data-priority={item.priority}
                    className={styles.planRow}
                  >
                    <span className={styles.planId}>%{item.id}</span>
                    <div className={styles.planItemMain}>
                      {item.text}{' '}
                      <StatusBadge status={item.status} />
                      {' '}
                      <ProjectScopeBadge scope={item.projectScope} />
                      {' '}
                      <PriorityLabel priority={item.priority} />
                      {item.isImportant && (
                        <>
                          {' '}
                          <ImportantBadge />
                        </>
                      )}
                      {item.isUrgent && (
                        <>
                          {' '}
                          <UrgentBadge />
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.planFooter}>
              <Link
                href="/plans"
                className={`${styles.secondaryButton} ${styles.planFooterButton}`}
              >
                View All Plans
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
