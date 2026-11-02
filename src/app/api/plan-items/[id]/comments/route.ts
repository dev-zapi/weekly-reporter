import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { periodPlanItems } from '@/lib/db/schema'
import {
  createComment,
  deriveCommentAuthor,
  getChainCommentCount,
  listChainComments,
} from '@/lib/plan-item-comments'

/**
 * Comments collection under a plan item. GET lists the item's own comments
 * plus its deferral-chain ancestors' comments oldest-first (each ancestor
 * comment carries its source period); there is deliberately no PUT/update
 * handler (comments are append-only, delete to correct).
 */
export const GET = withAuth(async function GET(
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

    return NextResponse.json({
      comments: await listChainComments(itemId),
      commentCount: await getChainCommentCount(itemId),
    })
  } catch (error) {
    console.error('Error fetching plan item comments:', error)
    return NextResponse.json(
      { error: 'Failed to fetch plan item comments', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
})

export const POST = withAuth(async function POST(
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

    const body = await request.json()
    const { content } = body

    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'Content is required and cannot be empty' },
        { status: 400 }
      )
    }

    // Comments are append-only; the author marker is attribution only
    // (browser → null, PAT → self-reported identity or token name).
    const comment = createComment(db, {
      planItemId: itemId,
      content: content.trim(),
      author: deriveCommentAuthor(request),
    })

    return NextResponse.json(comment, { status: 201 })
  } catch (error) {
    console.error('Error creating plan item comment:', error)
    return NextResponse.json(
      { error: 'Failed to create plan item comment', code: 'CREATE_ERROR' },
      { status: 500 }
    )
  }
})
