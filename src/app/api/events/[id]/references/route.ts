import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { rawEvents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { findReferrers } from '@/lib/references'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id: paramId } = await params
    const id = parseInt(paramId)

    if (isNaN(id)) {
      return NextResponse.json(
        { error: 'Invalid event ID' },
        { status: 400 }
      )
    }

    // Verify the event exists (even if no one references it).
    const event = db.select({ id: rawEvents.id })
      .from(rawEvents)
      .where(eq(rawEvents.id, id))
      .limit(1)
      .get()

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    }

    const referrers = findReferrers(db, id)
    return NextResponse.json({ referrers })
  } catch (error) {
    console.error('Error fetching event referrers:', error)
    return NextResponse.json(
      { error: 'Failed to fetch referrers', code: 'FETCH_REFERRERS_ERROR' },
      { status: 500 }
    )
  }
}
