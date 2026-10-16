import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { periodPlans, periodPlanItems } from '@/lib/db/schema'
import { addWeeks, addMonths, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns'
import { format } from 'date-fns'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const itemId = parseInt(id, 10)

    if (isNaN(itemId)) {
      return NextResponse.json(
        { error: 'Invalid item ID' },
        { status: 400 }
      )
    }

    // Get the item to defer
    const items = await db.select()
      .from(periodPlanItems)
      .where(eq(periodPlanItems.id, itemId))
      .all()

    if (items.length === 0) {
      return NextResponse.json(
        { error: 'Plan item not found' },
        { status: 404 }
      )
    }

    const originalItem = items[0]

    // Get the plan for this item
    const plans = await db.select()
      .from(periodPlans)
      .where(eq(periodPlans.id, originalItem.periodPlanId))
      .all()

    if (plans.length === 0) {
      return NextResponse.json(
        { error: 'Period plan not found' },
        { status: 404 }
      )
    }

    const originalPlan = plans[0]

    // Calculate next period
    let nextPeriodStart: string
    let nextPeriodEnd: string
    let nextMonthKey: string | null = null

    if (originalPlan.scope === 'week') {
      // Parse the current period start date
      const currentDate = new Date(originalPlan.periodStart + 'T00:00:00')
      const nextDate = addWeeks(currentDate, 1)
      const nextStart = startOfWeek(nextDate, { weekStartsOn: 1 })
      const nextEnd = endOfWeek(nextDate, { weekStartsOn: 1 })
      nextPeriodStart = format(nextStart, 'yyyy-MM-dd')
      nextPeriodEnd = format(nextEnd, 'yyyy-MM-dd')
    } else {
      // month scope
      const currentDate = new Date(originalPlan.periodStart + 'T00:00:00')
      const nextDate = addMonths(currentDate, 1)
      const nextStart = startOfMonth(nextDate)
      const nextEnd = endOfMonth(nextDate)
      nextPeriodStart = format(nextStart, 'yyyy-MM-dd')
      nextPeriodEnd = format(nextEnd, 'yyyy-MM-dd')
      nextMonthKey = format(nextDate, 'yyyy-MM')
    }

    // Find or create the next period plan
    const existingNextPlans = await db.select()
      .from(periodPlans)
      .where(
        sql`${periodPlans.scope} = ${originalPlan.scope} AND ${periodPlans.periodStart} = ${nextPeriodStart} AND ${periodPlans.periodEnd} = ${nextPeriodEnd}`
      )
      .all()

    let nextPlanId: number
    const now = new Date()

    if (existingNextPlans.length > 0) {
      nextPlanId = existingNextPlans[0].id
    } else {
      // Create new plan
      const newPlan = await db.insert(periodPlans).values({
        scope: originalPlan.scope,
        periodStart: nextPeriodStart,
        periodEnd: nextPeriodEnd,
        monthKey: nextMonthKey,
        createdAt: now,
        updatedAt: now,
      }).returning().all()

      nextPlanId = newPlan[0].id
    }

    // Get max position for the next plan
    const maxPositionResult = await db.select({
      maxPos: sql<number>`COALESCE(MAX(${periodPlanItems.position}), 0)`
    })
      .from(periodPlanItems)
      .where(eq(periodPlanItems.periodPlanId, nextPlanId))
      .all()

    const maxPosition = maxPositionResult[0]?.maxPos || 0
    const newPosition = maxPosition + 1

    // Create the deferred item in the next period
    const newDeferredItem = await db.insert(periodPlanItems).values({
      periodPlanId: nextPlanId,
      text: originalItem.text,
      status: 'planned',
      projectScope: originalItem.projectScope,
      parentItemId: originalItem.parentItemId,
      deferredFromItemId: originalItem.id,
      position: newPosition,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    // Mark the original item as deferred
    await db.update(periodPlanItems)
      .set({
        status: 'deferred',
        updatedAt: now,
      })
      .where(eq(periodPlanItems.id, originalItem.id))
      .run()

    return NextResponse.json(newDeferredItem[0], { status: 201 })
  } catch (error) {
    console.error('Error deferring plan item:', error)
    return NextResponse.json(
      { error: 'Failed to defer plan item', code: 'DEFER_ERROR' },
      { status: 500 }
    )
  }
}
