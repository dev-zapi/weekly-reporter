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

/**
 * Fixed-light status tones from DESIGN.md. These badges render inside the
 * Numbered Evidence surfaces, which keep their palette in both themes; no
 * `dark:` variants belong here.
 */
export const PLAN_ITEM_STATUS_COLORS: Record<PeriodPlanItemStatus, string> = {
  planned: 'rounded-[3px] border-[#c3d0dd] bg-[#eef2f6] text-[#42546a]',
  in_progress: 'rounded-[3px] border-[#b9cdf0] bg-[#eaf1fd] text-[#214fae]',
  done: 'rounded-[3px] border-[#b9dcc8] bg-[#e9f5ee] text-[#18794e]',
  cancelled: 'rounded-[3px] border-[#e4bcbc] bg-[#fff1f1] text-[#a43b3b]',
  deferred: 'rounded-[3px] border-[#eccf9c] bg-[#fff3dd] text-[#8a4d05]',
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
 * Priority dot tones from the fixed-light palette. The visible priority label
 * carries the meaning; the dot is a secondary cue, never the only signal.
 */
export const PLAN_ITEM_PRIORITY_TINTS: Record<PeriodPlanItemPriority, string> = {
  high: 'bg-[#214fae]',
  normal: 'bg-[#8fa5bd]',
  low: 'bg-[#cbd6e2]',
}
