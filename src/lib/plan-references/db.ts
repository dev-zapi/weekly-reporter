import 'server-only'
import { eq } from 'drizzle-orm'
import { eventPlanReferences } from '@/lib/db/schema'

type DrizzleDb = ReturnType<typeof import('@/lib/db').getDb>
type QueryRunner = Pick<DrizzleDb, 'select' | 'insert' | 'delete'>

export function syncEventPlanReferences(
  tx: QueryRunner,
  eventId: number,
  planItemIds: number[],
): void {
  tx.delete(eventPlanReferences).where(eq(eventPlanReferences.eventId, eventId)).run()
  if (planItemIds.length === 0) return
  const now = new Date()
  tx.insert(eventPlanReferences)
    .values(planItemIds.map((planItemId) => ({ eventId, planItemId, createdAt: now })))
    .run()
}

export function deleteEventPlanReferences(tx: QueryRunner, eventId: number): void {
  tx.delete(eventPlanReferences)
    .where(eq(eventPlanReferences.eventId, eventId))
    .run()
}

/**
 * Remove the inbound index rows for a deleted plan item, mirroring how
 * deleteEventReferences clears the referenced-event direction. The `%id` text
 * stays in event content (a dangling reference, per ADR-0019); only the
 * association row is cleared so fulfillment reads never point at a dead item.
 */
export function deleteEventPlanReferencesByPlanItem(
  tx: QueryRunner,
  planItemId: number,
): void {
  tx.delete(eventPlanReferences)
    .where(eq(eventPlanReferences.planItemId, planItemId))
    .run()
}
