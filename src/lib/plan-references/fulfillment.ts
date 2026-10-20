import 'server-only'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { periodPlanItems, eventPlanReferences, rawEvents } from '@/lib/db/schema'

/**
 * Walk the deferral chain (deferredFromItemId) to collect all ancestor item IDs.
 * Returns [itemId, ...ancestors] where ancestors are the items this one was deferred FROM.
 * Cycle-safe: stops if it encounters an already-visited ID.
 */
export async function getFulfillmentChain(itemId: number): Promise<number[]> {
  const db = getDb()
  const chain: number[] = []
  const visited = new Set<number>()
  let currentId: number | null = itemId

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId)
    const items = await db
      .select({ id: periodPlanItems.id, deferredFromItemId: periodPlanItems.deferredFromItemId })
      .from(periodPlanItems)
      .where(eq(periodPlanItems.id, currentId))
      .all()

    if (items.length === 0) {
      break
    }

    chain.push(currentId)
    currentId = items[0].deferredFromItemId
  }

  return chain
}

/**
 * Count fulfilling events for an item and its deferral chain ancestors.
 * Counts distinct events: an event that references two items in the same
 * deferral chain is a single piece of work and must count once.
 */
export async function getFulfillmentCount(itemId: number): Promise<number> {
  const db = getDb()
  const chain = await getFulfillmentChain(itemId)

  if (chain.length === 0) {
    return 0
  }

  const distinctEvents = await db
    .selectDistinct({ eventId: eventPlanReferences.eventId })
    .from(eventPlanReferences)
    .where(inArray(eventPlanReferences.planItemId, chain))
    .all()

  return distinctEvents.length
}

export interface FulfillingEvent {
  id: number
  content: string
  eventTime: Date
  isManual: boolean
}

/**
 * Get fulfilling events for an item and its deferral chain ancestors.
 * Returns event time, content summary, and manual/collected marker.
 * Deduped by event id: an event referencing two items in the same chain is
 * listed once.
 */
export async function getFulfillingEvents(itemId: number): Promise<FulfillingEvent[]> {
  const db = getDb()
  const chain = await getFulfillmentChain(itemId)

  if (chain.length === 0) {
    return []
  }

  const rows = await db
    .select({
      id: rawEvents.id,
      content: rawEvents.content,
      eventTime: rawEvents.eventTime,
      source: rawEvents.source,
    })
    .from(eventPlanReferences)
    .innerJoin(rawEvents, eq(eventPlanReferences.eventId, rawEvents.id))
    .where(inArray(eventPlanReferences.planItemId, chain))
    .all()

  const seen = new Set<number>()
  const events: FulfillingEvent[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    events.push({
      id: row.id,
      content: row.content,
      eventTime: row.eventTime,
      isManual: row.source === 'manual',
    })
  }
  return events
}
