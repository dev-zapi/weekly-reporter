'use client'

import { EventCard } from './EventCard'
import type { TimelineEvent } from '@/lib/event-view'
import type { RawEvent } from '@/lib/db/schema'
import styles from './timeline.module.css'

interface TimelineGroupProps {
  title: string
  events: TimelineEvent[]
  onEdit?: (id: number, data: Partial<RawEvent>) => Promise<void>
  onDelete?: (id: number) => Promise<void>
  onReferenceClick?: (referenceId: number) => void
  onPlanReferenceClick?: (planItemId: number) => void
  highlightKey?: number | null
  highlightEventId?: number | null
  selectedEventId?: number | null
  onEventSelect?: (eventId: number) => void
}

export function TimelineGroup({
  title,
  events,
  onEdit,
  onDelete,
  onReferenceClick,
  onPlanReferenceClick,
  highlightKey,
  highlightEventId,
  selectedEventId,
  onEventSelect,
}: TimelineGroupProps) {
  return (
    <section className={styles.group} aria-label={title}>
      <header className={styles.groupHeader}>
        <h3 className={styles.groupTitle} suppressHydrationWarning>{title}</h3>
        <span className={styles.groupCount}>
          {events.length} {events.length === 1 ? 'record' : 'records'}
        </span>
      </header>
      <div className={styles.eventList}>
        {events.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            commentReferrerCount={event.commentReferrerCount}
            onEdit={onEdit}
            onDelete={onDelete}
            onReferenceClick={onReferenceClick}
            onPlanReferenceClick={onPlanReferenceClick}
            highlightKey={highlightEventId === event.id ? highlightKey : null}
            selected={selectedEventId === event.id}
            onSelect={onEventSelect}
          />
        ))}
      </div>
    </section>
  )
}
