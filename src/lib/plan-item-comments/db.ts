import 'server-only'
import { asc, eq, inArray } from 'drizzle-orm'
import { commentReferences, planItemComments, type PlanItemComment } from '@/lib/db/schema'
import { parseReferences } from '@/lib/references/parse'

type DrizzleDb = ReturnType<typeof import('@/lib/db').getDb>
// The tx inside db.transaction() shares the query-builder interface of db but
// is a distinct type (SQLiteTransaction). Use a structural type so callers can
// pass either db or tx.
type QueryRunner = Pick<DrizzleDb, 'select' | 'insert' | 'delete'>

export interface NewCommentInput {
  planItemId: number
  content: string
  author: string | null
}

/**
 * List an item's own comments oldest-first. Deferral-chain aggregation is a
 * separate display concern (the comments stay pinned to the item they were
 * written on); `id` breaks ties when two comments share a timestamp.
 */
export function listComments(db: DrizzleDb, planItemId: number): PlanItemComment[] {
  return db
    .select()
    .from(planItemComments)
    .where(eq(planItemComments.planItemId, planItemId))
    .orderBy(asc(planItemComments.createdAt), asc(planItemComments.id))
    .all()
}

export function getCommentCount(db: DrizzleDb, planItemId: number): number {
  return db
    .select({ id: planItemComments.id })
    .from(planItemComments)
    .where(eq(planItemComments.planItemId, planItemId))
    .all().length
}

/**
 * Create a comment and index its `@<eventId>` citations in the same
 * transaction. This is the only parse: comments are immutable, so there is no
 * re-sync path later (deletion is the only mutation). `%<itemId>` and `#tag`
 * are deliberately never parsed here — plan references and tags stay plain text
 * inside comments.
 */
export function createComment(db: DrizzleDb, input: NewCommentInput): PlanItemComment {
  const referencedIds = parseReferences(input.content)

  return db.transaction((tx) => {
    const inserted = tx
      .insert(planItemComments)
      .values({
        planItemId: input.planItemId,
        content: input.content,
        author: input.author,
        createdAt: new Date(),
      })
      .returning()
      .all()
    const comment = inserted[0]

    if (referencedIds.length > 0) {
      const now = new Date()
      tx.insert(commentReferences)
        .values(
          referencedIds.map((referencedEventId) => ({
            commentId: comment.id,
            referencedEventId,
            createdAt: now,
          })),
        )
        .run()
    }

    return comment
  })
}

export function findComment(db: DrizzleDb, commentId: number): PlanItemComment | null {
  const rows = db
    .select()
    .from(planItemComments)
    .where(eq(planItemComments.id, commentId))
    .all()
  return rows[0] ?? null
}

/**
 * Delete one comment and its citation index rows. Comments are immutable, so
 * there is no re-sync path; deletion is the only mutation.
 */
export function deleteComment(db: DrizzleDb, commentId: number): boolean {
  return db.transaction((tx) => {
    tx.delete(commentReferences).where(eq(commentReferences.commentId, commentId)).run()
    const deleted = tx
      .delete(planItemComments)
      .where(eq(planItemComments.id, commentId))
      .returning()
      .all()
    return deleted.length > 0
  })
}

/**
 * Cascade helper for plan item deletion: drop the item's comments and the
 * citation rows that point at them. Runs inside the caller's transaction so the
 * item deletion and the comment cleanup commit together.
 */
export function deleteCommentsByPlanItem(tx: QueryRunner, planItemId: number): void {
  const comments = tx
    .select({ id: planItemComments.id })
    .from(planItemComments)
    .where(eq(planItemComments.planItemId, planItemId))
    .all()

  if (comments.length > 0) {
    tx.delete(commentReferences)
      .where(inArray(commentReferences.commentId, comments.map((comment) => comment.id)))
      .run()
  }

  tx.delete(planItemComments).where(eq(planItemComments.planItemId, planItemId)).run()
}
