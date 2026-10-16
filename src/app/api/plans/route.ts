import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq, and, asc } from 'drizzle-orm'
import { periodPlans, periodPlanItems } from '@/lib/db/schema'
import { getWeekPeriodRange, getMonthPeriodRange, getMonthPeriodRangeByKey } from '@/lib/periods'
import { DATE_REGEX, MONTH_REGEX } from '@/lib/validations'

export async function GET(request: Request) {
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
        periodStart = weekStart
        periodEnd = weekEnd
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
      return NextResponse.json({
        plan: null,
        items: []
      })
    }

    const planRow = plan[0]

    // Query items for this plan, ordered by position
    const items = await db.select()
      .from(periodPlanItems)
      .where(eq(periodPlanItems.periodPlanId, planRow.id))
      .orderBy(asc(periodPlanItems.position))
      .all()

    return NextResponse.json({
      plan: planRow,
      items
    })
  } catch (error) {
    console.error('Error fetching plans:', error)
    return NextResponse.json(
      { error: 'Failed to fetch plans', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
}
