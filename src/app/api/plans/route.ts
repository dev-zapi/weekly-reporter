import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq, and, asc, gte, lte, inArray, sql } from 'drizzle-orm'
import { periodPlans, periodPlanItems, type PeriodPlan, type PeriodPlanItem } from '@/lib/db/schema'
import { getWeekPeriodRange, getMonthPeriodRange, getMonthPeriodRangeByKey } from '@/lib/periods'
import { DATE_REGEX, MONTH_REGEX } from '@/lib/validations'
import { getFulfillmentChain, getFulfillmentCount } from '@/lib/plan-references'
import { getChainCommentCount } from '@/lib/plan-item-comments'

export const GET = withAuth(async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)
    const scope = searchParams.get('scope')
    const dateParam = searchParams.get('date')
    const weekStart = searchParams.get('weekStart')
    const weekEnd = searchParams.get('weekEnd')
    const month = searchParams.get('month')

    // Validate scope
    if (!scope || (scope !== 'week' && scope !== 'month')) {
      return NextResponse.json(
        { error: 'Invalid or missing scope parameter. Must be "week" or "month"' },
        { status: 400 }
      )
    }

    let periodStart: string | null = null
    let periodEnd: string | null = null

    if (scope === 'week') {
      if (dateParam) {
        if (!DATE_REGEX.test(dateParam)) {
          return NextResponse.json(
            { error: 'Invalid date format. Use YYYY-MM-DD' },
            { status: 400 }
          )
        }
        const date = new Date(dateParam + 'T00:00:00')
        const range = getWeekPeriodRange(date)
        periodStart = range.start
        periodEnd = range.end
      } else if (weekStart && weekEnd) {
        if (!DATE_REGEX.test(weekStart) || !DATE_REGEX.test(weekEnd)) {
          return NextResponse.json(
            { error: 'Invalid weekStart or weekEnd format. Use YYYY-MM-DD' },
            { status: 400 }
          )
        }
        // Canonicalize to the Monday-start week rather than trusting the raw
        // pair, so any date within the week resolves to the same plan row.
        const date = new Date(weekStart + 'T00:00:00')
        const range = getWeekPeriodRange(date)
        periodStart = range.start
        periodEnd = range.end
      } else {
        return NextResponse.json(
          { error: 'For week scope, provide either date or weekStart+weekEnd' },
          { status: 400 }
        )
      }
    } else {
      // month scope
      if (month) {
        if (!MONTH_REGEX.test(month)) {
          return NextResponse.json(
            { error: 'Invalid month format. Use YYYY-MM' },
            { status: 400 }
          )
        }
        const range = getMonthPeriodRangeByKey(month)
        periodStart = range.start
        periodEnd = range.end
      } else if (dateParam) {
        if (!DATE_REGEX.test(dateParam)) {
          return NextResponse.json(
            { error: 'Invalid date format. Use YYYY-MM-DD' },
            { status: 400 }
          )
        }
        const date = new Date(dateParam + 'T00:00:00')
        const range = getMonthPeriodRange(date)
        periodStart = range.start
        periodEnd = range.end
      } else {
        return NextResponse.json(
          { error: 'For month scope, provide either month or date' },
          { status: 400 }
        )
      }
    }

    // Query for the plan
    const plan = await db.select()
      .from(periodPlans)
      .where(
        and(
          eq(periodPlans.scope, scope),
          eq(periodPlans.periodStart, periodStart),
          eq(periodPlans.periodEnd, periodEnd)
        )
      )
      .all()

    if (plan.length === 0) {
      if (scope === 'month') {
        const attachCandidates = await getAttachCandidates(periodStart, periodEnd)
        return NextResponse.json({
          plan: null,
          items: [],
          attachCandidates
        })
      }

      return NextResponse.json({
        plan: null,
        items: []
      })
    }

    const planRow = plan[0]

    // Group by priority (high -> normal -> low), then manual position within a
    // group. A CASE is required: plain lexicographic ASC would order high, low,
    // normal. This is the only item-ordering site; labels and tints for both
    // UIs live in plan-item-display.ts.
    const items = await db.select()
      .from(periodPlanItems)
      .where(eq(periodPlanItems.periodPlanId, planRow.id))
      .orderBy(
        sql`CASE ${periodPlanItems.priority} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`,
        asc(periodPlanItems.position)
      )
      .all()

    if (scope === 'month') {
      // Month scope extends the flat list into the 月度回看 tree: monthly items
      // are the spine, attached week items hang off them, and unparented week
      // items surface as attach candidates grouped by week.
      const review = await composeMonthReview(planRow, items)
      return NextResponse.json({
        plan: planRow,
        items: review.items,
        attachCandidates: review.attachCandidates
      })
    }

    // Add fulfillment count and plan-side comment count to each item. Both are
    // chain-aggregated: a deferred successor shows its ancestors' work and
    // notes, matching what its expanded sections render.
    const itemsWithCounts = await Promise.all(
      items.map(async (item) => {
        const fulfillmentCount = await getFulfillmentCount(item.id)
        const commentCount = await getChainCommentCount(item.id)
        return { ...item, fulfillmentCount, commentCount }
      })
    )

    return NextResponse.json({
      plan: planRow,
      items: itemsWithCounts
    })
  } catch (error) {
    console.error('Error fetching plans:', error)
    return NextResponse.json(
      { error: 'Failed to fetch plans', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
})

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 }

function compareByPriorityThenPosition(a: PeriodPlanItem, b: PeriodPlanItem): number {
  const byPriority = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)
  if (byPriority !== 0) return byPriority
  if (a.position !== b.position) return a.position - b.position
  return a.id - b.id
}

/**
 * The weeks attributed to a month: Monday-start weeks whose start day falls in
 * the month's range. Week→month attribution stays derived; no plan-level link
 * is read here. Weeks starting in an adjacent month are deliberately absent, so
 * the same helper scopes both children and attach candidates.
 */
async function getMonthWeeks(monthStart: string, monthEnd: string): Promise<PeriodPlan[]> {
  const db = getDb()
  return db.select()
    .from(periodPlans)
    .where(
      and(
        eq(periodPlans.scope, 'week'),
        gte(periodPlans.periodStart, monthStart),
        lte(periodPlans.periodStart, monthEnd)
      )
    )
    .orderBy(asc(periodPlans.periodStart))
    .all()
}

async function getWeekItems(weekPlanIds: number[]): Promise<PeriodPlanItem[]> {
  if (weekPlanIds.length === 0) return []
  const db = getDb()
  return db.select()
    .from(periodPlanItems)
    .where(inArray(periodPlanItems.periodPlanId, weekPlanIds))
    .all()
}

function buildAttachCandidates(
  weekPlans: PeriodPlan[],
  weekItems: PeriodPlanItem[]
): Array<{
  periodStart: string
  periodEnd: string
  items: Array<{
    id: number
    text: string
    status: PeriodPlanItem['status']
    projectScope: PeriodPlanItem['projectScope']
    priority: PeriodPlanItem['priority']
    isImportant: boolean
    isUrgent: boolean
  }>
}> {
  return weekPlans
    .map((weekPlan) => ({
      periodStart: weekPlan.periodStart,
      periodEnd: weekPlan.periodEnd,
      items: weekItems
        .filter((item) => item.periodPlanId === weekPlan.id && item.parentItemId === null)
        .sort(compareByPriorityThenPosition)
        .map((item) => ({
          id: item.id,
          text: item.text,
          status: item.status,
          projectScope: item.projectScope,
          priority: item.priority,
          isImportant: item.isImportant,
          isUrgent: item.isUrgent
        }))
    }))
    // An empty week has nothing to attach; omit it rather than show dead groups.
    .filter((week) => week.items.length > 0)
}

async function getAttachCandidates(monthStart: string, monthEnd: string) {
  const weekPlans = await getMonthWeeks(monthStart, monthEnd)
  const weekItems = await getWeekItems(weekPlans.map((plan) => plan.id))
  return buildAttachCandidates(weekPlans, weekItems)
}

/**
 * Compose the 月度回看 payload for a month plan:
 * - each monthly item carries its attached week items (week attribution included)
 * - composed fulfillment = direct (events citing the monthly item, chain
 *   aggregated) + indirect (per attached week item, chain aggregated per child)
 * - a deferred monthly successor also aggregates the children attached to its
 *   deferral-chain ancestors (the mirror of the week-item deferral rule)
 * - attach candidates are the month's weeks' unparented week items, grouped by
 *   week; unparented items never appear in the tree
 *
 * Comments stay per item chain: they do not roll up across levels (ADR-0024).
 */
async function composeMonthReview(planRow: PeriodPlan, monthItems: PeriodPlanItem[]) {
  const db = getDb()
  const weekPlans = await getMonthWeeks(planRow.periodStart, planRow.periodEnd)
  const weekItems = await getWeekItems(weekPlans.map((plan) => plan.id))
  const weekPlanById = new Map(weekPlans.map((plan) => [plan.id, plan]))

  const childrenByParent = new Map<number, PeriodPlanItem[]>()
  for (const weekItem of weekItems) {
    if (weekItem.parentItemId === null) continue
    const siblings = childrenByParent.get(weekItem.parentItemId) ?? []
    siblings.push(weekItem)
    childrenByParent.set(weekItem.parentItemId, siblings)
  }

  const items = await Promise.all(
    monthItems.map(async (item) => {
      const childRows = (childrenByParent.get(item.id) ?? []).sort(compareByPriorityThenPosition)

      const [directFulfillmentCount, commentCount] = await Promise.all([
        getFulfillmentCount(item.id),
        getChainCommentCount(item.id)
      ])

      const childItems = await Promise.all(
        childRows.map(async (child) => {
          const weekPlan = weekPlanById.get(child.periodPlanId)!
          const [fulfillmentCount, childCommentCount] = await Promise.all([
            getFulfillmentCount(child.id),
            getChainCommentCount(child.id)
          ])
          return {
            id: child.id,
            text: child.text,
            status: child.status,
            projectScope: child.projectScope,
            priority: child.priority,
            isImportant: child.isImportant,
            isUrgent: child.isUrgent,
            weekPeriodStart: weekPlan.periodStart,
            weekPeriodEnd: weekPlan.periodEnd,
            fulfillmentCount,
            commentCount: childCommentCount
          }
        })
      )

      // Deferral mirror: a successor aggregates not just its own attached week
      // items but also those attached to the month items it was deferred from.
      // Children themselves never migrate.
      const chain = await getFulfillmentChain(item.id)
      const ancestorIds = chain.filter((id) => id !== item.id)
      const ancestorChildren = ancestorIds.length === 0
        ? []
        : await db.select()
            .from(periodPlanItems)
            .where(inArray(periodPlanItems.parentItemId, ancestorIds))
            .all()

      const indirectCounts = await Promise.all(
        [...childRows, ...ancestorChildren].map((child) => getFulfillmentCount(child.id))
      )
      const indirectFulfillmentCount = indirectCounts.reduce((sum, count) => sum + count, 0)

      return {
        ...item,
        directFulfillmentCount,
        indirectFulfillmentCount,
        fulfillmentCount: directFulfillmentCount + indirectFulfillmentCount,
        commentCount,
        childItems
      }
    })
  )

  return {
    items,
    attachCandidates: buildAttachCandidates(weekPlans, weekItems)
  }
}
