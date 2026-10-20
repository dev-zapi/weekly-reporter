import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { periodPlans, periodPlanItems, type PeriodPlan } from '@/lib/db/schema'
import { getMonthPeriodRangeByKey } from '@/lib/periods'
import { DATE_REGEX, MONTH_REGEX } from '@/lib/validations'
import { ensurePeriodPlan, validateParentLink } from '@/lib/plan-items'

export const POST = withAuth(async function POST(request: Request) {
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

    let targetPlan: PeriodPlan

    // If periodPlanId not provided, ensure the plan exists
    if (!periodPlanId) {
      if (!scope || (scope !== 'week' && scope !== 'month')) {
        return NextResponse.json(
          { error: 'Either periodPlanId or scope is required' },
          { status: 400 }
        )
      }

      let periodStart: string
      let periodEnd: string
      let monthKey: string | null = null

      if (scope === 'week') {
        if (!weekStart || !weekEnd) {
          return NextResponse.json(
            { error: 'For week scope, weekStart and weekEnd are required' },
            { status: 400 }
          )
        }
        if (
          typeof weekStart !== 'string' ||
          typeof weekEnd !== 'string' ||
          !DATE_REGEX.test(weekStart) ||
          !DATE_REGEX.test(weekEnd)
        ) {
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
        if (!MONTH_REGEX.test(month)) {
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

      targetPlan = await ensurePeriodPlan({ scope, periodStart, periodEnd, monthKey })
    } else {
      // Verify the plan exists
      const plan = await db.select()
        .from(periodPlans)
        .where(eq(periodPlans.id, periodPlanId))
        .all()

      if (plan.length === 0) {
        return NextResponse.json(
          { error: 'Period plan not found' },
          { status: 404 }
        )
      }

      targetPlan = plan[0]
    }

    const targetPlanId = targetPlan.id

    // Validate an optional parent link against the target plan's period.
    if (parentItemId !== undefined && parentItemId !== null) {
      const validation = await validateParentLink({
        childScope: targetPlan.scope,
        childPeriodStart: targetPlan.periodStart,
        parentItemId,
      })
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
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
})
