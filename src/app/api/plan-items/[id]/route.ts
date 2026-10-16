import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { periodPlanItems } from '@/lib/db/schema'

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

    return NextResponse.json(items[0])
  } catch (error) {
    console.error('Error fetching plan item:', error)
    return NextResponse.json(
      { error: 'Failed to fetch plan item', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
}

export async function PUT(
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

    const body = await request.json()
    const { text, status, projectScope, position, parentItemId } = body

    // Validate text if provided
    if (text !== undefined) {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return NextResponse.json(
          { error: 'Text cannot be empty' },
          { status: 400 }
        )
      }
    }

    // Validate status if provided
    if (status !== undefined) {
      const validStatuses = ['planned', 'in_progress', 'done', 'cancelled', 'deferred']
      if (!validStatuses.includes(status)) {
        return NextResponse.json(
          { error: 'Invalid status. Must be one of: planned, in_progress, done, cancelled, deferred' },
          { status: 400 }
        )
      }
    }

    // Validate projectScope if provided
    if (projectScope !== undefined) {
      if (projectScope !== 'work' && projectScope !== 'personal') {
        return NextResponse.json(
          { error: 'projectScope must be "work" or "personal"' },
          { status: 400 }
        )
      }
    }

    // Check if item exists
    const existingItems = await db.select()
      .from(periodPlanItems)
      .where(eq(periodPlanItems.id, itemId))
      .all()

    if (existingItems.length === 0) {
      return NextResponse.json(
        { error: 'Plan item not found' },
        { status: 404 }
      )
    }

    // Build update object
    const updates: Record<string, unknown> = {
      updatedAt: new Date()
    }

    if (text !== undefined) updates.text = text.trim()
    if (status !== undefined) updates.status = status
    if (projectScope !== undefined) updates.projectScope = projectScope
    if (position !== undefined) updates.position = position
    if (parentItemId !== undefined) updates.parentItemId = parentItemId

    // Update the item
    const updated = await db.update(periodPlanItems)
      .set(updates)
      .where(eq(periodPlanItems.id, itemId))
      .returning()
      .all()

    return NextResponse.json(updated[0])
  } catch (error) {
    console.error('Error updating plan item:', error)
    return NextResponse.json(
      { error: 'Failed to update plan item', code: 'UPDATE_ERROR' },
      { status: 500 }
    )
  }
}

export async function DELETE(
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
    const existingItems = await db.select()
      .from(periodPlanItems)
      .where(eq(periodPlanItems.id, itemId))
      .all()

    if (existingItems.length === 0) {
      return NextResponse.json(
        { error: 'Plan item not found' },
        { status: 404 }
      )
    }

    // Delete the item
    await db.delete(periodPlanItems)
      .where(eq(periodPlanItems.id, itemId))
      .run()

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('Error deleting plan item:', error)
    return NextResponse.json(
      { error: 'Failed to delete plan item', code: 'DELETE_ERROR' },
      { status: 500 }
    )
  }
}
