import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { periodPlanItems } from '@/lib/db/schema'
import { deleteComment, findComment } from '@/lib/plan-item-comments'

/**
 * Delete a single plan item comment (and its citation index rows). Comments have
 * no update endpoint on purpose: append to correct, delete to retract.
 */
export const DELETE = withAuth(async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  try {
    const db = getDb()
    const { id, commentId: rawCommentId } = await params
    const itemId = parseInt(id, 10)
    const commentId = parseInt(rawCommentId, 10)

    if (isNaN(itemId)) {
      return NextResponse.json(
        { error: 'Invalid item ID' },
        { status: 400 }
      )
    }

    if (isNaN(commentId)) {
      return NextResponse.json(
        { error: 'Invalid comment ID' },
        { status: 400 }
      )
    }

    const items = await db
      .select({ id: periodPlanItems.id })
      .from(periodPlanItems)
      .where(eq(periodPlanItems.id, itemId))
      .all()

    if (items.length === 0) {
      return NextResponse.json(
        { error: 'Plan item not found' },
        { status: 404 }
      )
    }

    // The nested path is the ownership check: a comment is only reachable
    // through the item it was written on.
    const comment = findComment(db, commentId)
    if (!comment || comment.planItemId !== itemId) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 }
      )
    }

    deleteComment(db, commentId)

    return NextResponse.json({ deleted: true })
  } catch (error) {
    console.error('Error deleting plan item comment:', error)
    return NextResponse.json(
      { error: 'Failed to delete plan item comment', code: 'DELETE_ERROR' },
      { status: 500 }
    )
  }
})
