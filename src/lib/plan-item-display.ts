import type { LucideIcon } from 'lucide-react'
import { ArrowRight, Circle, CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import type { PeriodPlanItemStatus } from '@/lib/db/schema'

/**
 * Single source of truth for how plan-item statuses are labelled and coloured
 * across the plans page and the timeline panel. Keeping the display order as
 * the key order avoids a second status list drifting from the schema enum.
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
