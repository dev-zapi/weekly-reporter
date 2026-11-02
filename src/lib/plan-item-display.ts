import type { LucideIcon } from 'lucide-react'
import { ArrowRight, Circle, CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import type { PeriodPlanItemPriority, PeriodPlanItemStatus } from '@/lib/db/schema'

/**
 * Single source of truth for how plan-item labels, colours, and tints are
 * presented across the plans page and the timeline panel. Keeping the display
 * order as the key order avoids a second list drifting from the schema enum.
 */
export const PLAN_ITEM_STATUS_LABELS: Record<PeriodPlanItemStatus, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
  deferred: 'Deferred',
}

export const PLAN_ITEM_STATUS_COLORS: Record<PeriodPlanItemStatus, string> = {
  planned: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  deferred: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
}

export const PLAN_ITEM_STATUS_ORDER = Object.keys(
  PLAN_ITEM_STATUS_LABELS,
) as PeriodPlanItemStatus[]

/**
 * Icon for each status, used in filter checkboxes and inline status badges.
 * Kept in the same key order as the labels so display stays consistent.
 */
export const PLAN_ITEM_STATUS_ICONS: Record<PeriodPlanItemStatus, LucideIcon> = {
  planned: Circle,
  in_progress: LoaderCircle,
  done: CircleCheck,
  cancelled: CircleX,
  deferred: ArrowRight,
}

/**
 * Priority labels are also display order: high -> normal -> low, matching the
 * grouping the plans endpoint applies. The manager uses the short Chinese
 * labels for its explicit per-row control.
 */
export const PLAN_ITEM_PRIORITY_LABELS: Record<PeriodPlanItemPriority, string> = {
  high: '高',
  normal: '中',
  low: '低',
}

export const PLAN_ITEM_PRIORITY_ORDER = Object.keys(
  PLAN_ITEM_PRIORITY_LABELS,
) as PeriodPlanItemPriority[]

/**
 * Priority is a scannable background tint rather than an icon or text label.
 * Each value gets a distinct tint so the timeline panel can be read at a
 * glance while remaining orthogonal to the important/urgent flag icons.
 */
export const PLAN_ITEM_PRIORITY_TINTS: Record<PeriodPlanItemPriority, string> = {
  high: 'bg-rose-500 dark:bg-rose-400',
  normal: 'bg-gray-400 dark:bg-gray-500',
  low: 'bg-sky-500 dark:bg-sky-400',
}

/** A softer version of the same tint fills the whole row for at-a-glance scanning. */
export const PLAN_ITEM_PRIORITY_ROW_TINTS: Record<PeriodPlanItemPriority, string> = {
  high: 'bg-rose-50 dark:bg-rose-950/40',
  normal: 'bg-muted/40',
  low: 'bg-sky-50 dark:bg-sky-950/40',
}
