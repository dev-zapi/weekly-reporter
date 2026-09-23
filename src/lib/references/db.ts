import { eq, or } from 'drizzle-orm'
import { eventReferences, rawEvents } from '@/lib/db/schema'

type DrizzleDb = ReturnType<typeof import('@/lib/db').getDb>
type QueryRunner = Pick<DrizzleDb, 'select' | 'insert' | 'delete'>

export function syncEventReferences(
  tx: QueryRunner,
  eventId: number,
  referencedIds: number[],
): void {
  tx.delete(eventReferences).where(eq(eventReferences.eventId, eventId)).run()
  if (referencedIds.length === 0) return
  const now = new Date()
  tx.insert(eventReferences)
    .values(referencedIds.map((referencedEventId) => ({ eventId, referencedEventId, createdAt: now })))
    .run()
}

export function deleteEventReferences(tx: QueryRunner, eventId: number): void {
  tx.delete(eventReferences)
    .where(or(eq(eventReferences.eventId, eventId), eq(eventReferences.referencedEventId, eventId)))
    .run()
}

export interface ReferrerEvent {
  id: number
  content: string
  eventTime: Date
}

export function findReferrers(db: DrizzleDb, referencedEventId: number): ReferrerEvent[] {
  const rows = db
    .select({
      id: rawEvents.id,
      content: rawEvents.content,
      eventTime: rawEvents.eventTime,
    })
    .from(eventReferences)
    .innerJoin(rawEvents, eq(eventReferences.eventId, rawEvents.id))
    .where(eq(eventReferences.referencedEventId, referencedEventId))
    .all()
  return rows
}
