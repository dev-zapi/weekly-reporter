import 'server-only'
import { asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  commentReferences,
  periodPlans,
  periodPlanItems,
  planItemComments,
  type PeriodPlanScope,
  type PlanItemComment,
} from '@/lib/db/schema'
import { getFulfillmentChain } from '@/lib/plan-references/fulfillment'

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

/** The period an aggregated comment was written in, for source-period labels. */
export interface CommentSourcePeriod {
  scope: PeriodPlanScope
  periodStart: string
  periodEnd: string
  monthKey: string | null
  label: string
}

/** A comment plus the period of the item it is pinned to. */
export interface ChainComment extends PlanItemComment {
  sourcePeriod: CommentSourcePeriod
}

function buildSourcePeriod(period: {
  scope: PeriodPlanScope
  periodStart: string
  periodEnd: string
  monthKey: string | null
}): CommentSourcePeriod {
  return {
    ...period,
    label:
      period.scope === 'week'
        ? `Week ${period.periodStart} - ${period.periodEnd}`
        : `Month ${period.monthKey ?? period.periodStart.slice(0, 7)}`,
  }
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
 * List the comments displayed on an item: its own plus every deferral-chain
 * ancestor's. Comments stay pinned to the item they were written on; this is a
 * read-side aggregation only. Order is oldest-first across the whole chain so
 * the history reads chronologically.
 */
export async function listChainComments(itemId: number): Promise<ChainComment[]> {
  const db = getDb()
  const chain = await getFulfillmentChain(itemId)

  if (chain.length === 0) {
    return []
  }

  const rows = db
    .select({
      id: planItemComments.id,
      planItemId: planItemComments.planItemId,
      content: planItemComments.content,
      author: planItemComments.author,
      createdAt: planItemComments.createdAt,
      scope: periodPlans.scope,
      periodStart: periodPlans.periodStart,
      periodEnd: periodPlans.periodEnd,
      monthKey: periodPlans.monthKey,
    })
    .from(planItemComments)
    .innerJoin(periodPlanItems, eq(planItemComments.planItemId, periodPlanItems.id))
    .innerJoin(periodPlans, eq(periodPlanItems.periodPlanId, periodPlans.id))
    .where(inArray(planItemComments.planItemId, chain))
    .orderBy(asc(planItemComments.createdAt), asc(planItemComments.id))
    .all()

  return rows.map(({ scope, periodStart, periodEnd, monthKey, ...comment }) => ({
    ...comment,
    sourcePeriod: buildSourcePeriod({ scope, periodStart, periodEnd, monthKey }),
  }))
}

/**
 * Chain-aggregated comment count. Must stay equal to listChainComments().length
 * so the badge never disagrees with the expanded section.
 */
export async function getChainCommentCount(itemId: number): Promise<number> {
  const db = getDb()
  const chain = await getFulfillmentChain(itemId)

  if (chain.length === 0) {
    return 0
  }

  return db
    .select({ id: planItemComments.id })
    .from(planItemComments)
    .where(inArray(planItemComments.planItemId, chain))
    .all().length
}

export function createComment(db: DrizzleDb, input: NewCommentInput): PlanItemComment {
  const inserted = db
    .insert(planItemComments)
    .values({
      planItemId: input.planItemId,
      content: input.content,
      author: input.author,
      createdAt: new Date(),
    })
    .returning()
    .all()
  return inserted[0]
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
