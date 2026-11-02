'use client'

import { EventCard } from './EventCard'
import type { TimelineEvent } from '@/lib/event-view'
import type { RawEvent } from '@/lib/db/schema'

interface TimelineGroupProps {
  title: string
  events: TimelineEvent[]
  onEdit?: (id: number, data: Partial<RawEvent>) => Promise<void>
  onDelete?: (id: number) => Promise<void>
  onReferenceClick?: (referenceId: number) => void
  onPlanReferenceClick?: (planItemId: number) => void
  highlightKey?: number | null
  highlightEventId?: number | null
}

export function TimelineGroup({ title, events, onEdit, onDelete, onReferenceClick, onPlanReferenceClick, highlightKey, highlightEventId }: TimelineGroupProps) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-sm" suppressHydrationWarning>{title}</h3>
      <div className="space-y-2">
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
          />
        ))}
      </div>
    </div>
  )
}
