import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { periodPlans, periodPlanItems } from '@/lib/db/schema'
import { getNextWeekPeriodRange, getNextMonthPeriodRange } from '@/lib/periods'
import { ensurePeriodPlan } from '@/lib/plan-items'

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

    // Calculate the next period (same scope).
    let nextPeriodStart: string
    let nextPeriodEnd: string
    let nextMonthKey: string | null = null

    if (originalPlan.scope === 'week') {
      const range = getNextWeekPeriodRange(originalPlan.periodStart)
      nextPeriodStart = range.start
      nextPeriodEnd = range.end
    } else {
      const range = getNextMonthPeriodRange(originalPlan.monthKey ?? originalPlan.periodStart.slice(0, 7))
      nextPeriodStart = range.start
      nextPeriodEnd = range.end
      nextMonthKey = range.monthKey
    }

    // Find or create the next period plan.
    const nextPlan = await ensurePeriodPlan({
      scope: originalPlan.scope,
      periodStart: nextPeriodStart,
      periodEnd: nextPeriodEnd,
      monthKey: nextMonthKey,
    })
    const nextPlanId = nextPlan.id
    const now = new Date()

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
