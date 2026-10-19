import 'server-only'
import { eq } from 'drizzle-orm'
import { eventPlanReferences, rawEvents } from '@/lib/db/schema'

type DrizzleDb = ReturnType<typeof import('@/lib/db').getDb>

export interface PlanReferrerEvent {
  id: number
  content: string
  eventTime: Date
}

export function findPlanReferrers(db: DrizzleDb, planItemId: number): PlanReferrerEvent[] {
  const rows = db
    .select({
      id: rawEvents.id,
      content: rawEvents.content,
      eventTime: rawEvents.eventTime,
    })
    .from(eventPlanReferences)
    .innerJoin(rawEvents, eq(eventPlanReferences.eventId, rawEvents.id))
    .where(eq(eventPlanReferences.planItemId, planItemId))
    .all()
  return rows
}
