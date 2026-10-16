import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { periodPlans, periodPlanItems, type PeriodPlan, type PeriodPlanScope } from '@/lib/db/schema'

/**
 * Finds the period plan for the given scope and period, creating it if it does
 * not exist yet. Auto-creating the row on first item is what lets a plan exist
 * without an explicit "create plan" step.
 */
export async function ensurePeriodPlan(params: {
  scope: PeriodPlanScope
  periodStart: string
  periodEnd: string
  monthKey: string | null
}): Promise<PeriodPlan> {
  const db = getDb()
  const existing = await db.select()
    .from(periodPlans)
    .where(
      and(
        eq(periodPlans.scope, params.scope),
        eq(periodPlans.periodStart, params.periodStart),
        eq(periodPlans.periodEnd, params.periodEnd),
      )
    )
    .all()

  if (existing.length > 0) {
    return existing[0]
  }

  const now = new Date()
  const created = await db.insert(periodPlans).values({
    scope: params.scope,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    monthKey: params.monthKey,
    createdAt: now,
    updatedAt: now,
  }).returning().all()

  return created[0]
}

export type ParentLinkValidation = { ok: true } | { ok: false; error: string }

/**
 * Validates an optional week-item -> month-item parent link. The structure is
 * one-way (a week item may hang off a month item, never the reverse) and the
 * parent's calendar month must contain the child week's start day, so the
 * parent chain never crosses a period boundary.
 */
export async function validateParentLink(params: {
  childScope: PeriodPlanScope
  childPeriodStart: string
  parentItemId: number
}): Promise<ParentLinkValidation> {
  const db = getDb()

  if (params.childScope !== 'week') {
    return { ok: false, error: 'parentItemId is only allowed on week items' }
  }

  const parentItems = await db.select()
    .from(periodPlanItems)
    .where(eq(periodPlanItems.id, params.parentItemId))
    .all()

  if (parentItems.length === 0) {
    return { ok: false, error: 'parentItemId does not reference an existing item' }
  }

  const parentPlans = await db.select()
    .from(periodPlans)
    .where(eq(periodPlans.id, parentItems[0].periodPlanId))
    .all()

  if (parentPlans.length === 0 || parentPlans[0].scope !== 'month') {
    return { ok: false, error: 'parentItemId must reference a month item' }
  }

  const parentPlan = parentPlans[0]
  const weekStart = params.childPeriodStart
  if (weekStart < parentPlan.periodStart || weekStart > parentPlan.periodEnd) {
    return { ok: false, error: 'parentItemId must belong to the month containing the week start date' }
  }

  return { ok: true }
}
