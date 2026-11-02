import type { RawEvent } from '@/lib/db/schema'

/**
 * A timeline event as returned by GET /api/events. The list query enriches
 * each row with the number of plan item comments citing it, so event cards can
 * show the cited-by marker without an extra request per card.
 */
export type TimelineEvent = RawEvent & {
  commentReferrerCount?: number
}
