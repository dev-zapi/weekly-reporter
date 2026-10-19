import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { periodPlanItems } from '@/lib/db/schema'
import { getFulfillingEvents } from '@/lib/plan-references'

export async function GET(
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

    // Check if item exists
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

    // Get fulfilling events (includes deferral chain ancestors)
    const events = await getFulfillingEvents(itemId)

    return NextResponse.json({ events })
  } catch (error) {
    console.error('Error fetching fulfilling events:', error)
    return NextResponse.json(
      { error: 'Failed to fetch fulfilling events', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
}
