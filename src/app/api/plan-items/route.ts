import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq, and, sql } from 'drizzle-orm'
import { periodPlans, periodPlanItems } from '@/lib/db/schema'
import { getWeekPeriodRange, getMonthPeriodRange, getMonthPeriodRangeByKey } from '@/lib/periods'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const monthRegex = /^\d{4}-\d{2}$/

export async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    const {
      periodPlanId,
      scope,
      weekStart,
      weekEnd,
      month,
      text,
      projectScope = 'work',
      parentItemId
    } = body

    // Validate text
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return NextResponse.json(
        { error: 'Text is required and cannot be empty' },
        { status: 400 }
      )
    }

    // Validate projectScope
    if (projectScope !== 'work' && projectScope !== 'personal') {
      return NextResponse.json(
        { error: 'projectScope must be "work" or "personal"' },
        { status: 400 }
      )
    }

    let targetPlanId = periodPlanId

    // If periodPlanId not provided, ensure the plan exists
    if (!targetPlanId) {
      if (!scope || (scope !== 'week' && scope !== 'month')) {
        return NextResponse.json(
          { error: 'Either periodPlanId or scope is required' },
          { status: 400 }
        )
      }

      let periodStart: string | null = null
      let periodEnd: string | null = null
      let monthKey: string | null = null

      if (scope === 'week') {
        if (!weekStart || !weekEnd) {
          return NextResponse.json(
            { error: 'For week scope, weekStart and weekEnd are required' },
            { status: 400 }
          )
        }
        if (!dateRegex.test(weekStart) || !dateRegex.test(weekEnd)) {
          return NextResponse.json(
            { error: 'Invalid weekStart or weekEnd format. Use YYYY-MM-DD' },
            { status: 400 }
          )
        }
        periodStart = weekStart
        periodEnd = weekEnd
      } else {
        // month scope
        if (!month) {
          return NextResponse.json(
            { error: 'For month scope, month parameter is required' },
            { status: 400 }
          )
        }
        if (!monthRegex.test(month)) {
          return NextResponse.json(
            { error: 'Invalid month format. Use YYYY-MM' },
            { status: 400 }
          )
        }
        const range = getMonthPeriodRangeByKey(month)
        periodStart = range.start
        periodEnd = range.end
        monthKey = month
      }

      // Try to find existing plan
      const existingPlan = await db.select()
        .from(periodPlans)
        .where(
          and(
            eq(periodPlans.scope, scope),
            eq(periodPlans.periodStart, periodStart),
            eq(periodPlans.periodEnd, periodEnd)
          )
        )
        .all()

      if (existingPlan.length > 0) {
        targetPlanId = existingPlan[0].id
      } else {
        // Create new plan
        const now = new Date()
        const newPlan = await db.insert(periodPlans).values({
          scope,
          periodStart,
          periodEnd,
          monthKey,
          createdAt: now,
          updatedAt: now,
        }).returning().all()

        targetPlanId = newPlan[0].id
      }
    } else {
      // Verify the plan exists
      const plan = await db.select()
        .from(periodPlans)
        .where(eq(periodPlans.id, targetPlanId))
        .all()

      if (plan.length === 0) {
        return NextResponse.json(
          { error: 'Period plan not found' },
          { status: 404 }
        )
      }
    }

    // Get max position for this plan
    const maxPositionResult = await db.select({
      maxPos: sql<number>`COALESCE(MAX(${periodPlanItems.position}), 0)`
    })
      .from(periodPlanItems)
      .where(eq(periodPlanItems.periodPlanId, targetPlanId))
      .all()

    const maxPosition = maxPositionResult[0]?.maxPos || 0
    const newPosition = maxPosition + 1

    // Create the item
    const now = new Date()
    const newItem = await db.insert(periodPlanItems).values({
      periodPlanId: targetPlanId,
      text: text.trim(),
      status: 'planned',
      projectScope,
      parentItemId: parentItemId || null,
      deferredFromItemId: null,
      position: newPosition,
      createdAt: now,
      updatedAt: now,
    }).returning().all()

    return NextResponse.json(newItem[0], { status: 201 })
  } catch (error) {
    console.error('Error creating plan item:', error)
    return NextResponse.json(
      { error: 'Failed to create plan item', code: 'CREATE_ERROR' },
      { status: 500 }
    )
  }
}
