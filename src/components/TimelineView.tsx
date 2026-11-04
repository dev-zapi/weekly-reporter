'use client'

import { useState, useMemo } from 'react'
import { startOfWeek, endOfWeek, getWeek } from 'date-fns'
import { Inbox } from 'lucide-react'
import { TimelineViewSwitcher } from './TimelineViewSwitcher'
import { TimelineGroup } from './TimelineGroup'
import type { TimelineEvent } from '@/lib/event-view'
import type { RawEvent } from '@/lib/db/schema'
import { toValidDate } from '@/lib/time-format'
import styles from './timeline.module.css'

type ViewMode = 'day' | 'week' | 'month'

interface TimelineViewProps {
  events: TimelineEvent[]
  onEdit?: (id: number, data: Partial<RawEvent>) => Promise<void>
  onDelete?: (id: number) => Promise<void>
  onReferenceClick?: (referenceId: number) => void
  onPlanReferenceClick?: (planItemId: number) => void
  highlightEventId?: number | null
  highlightKey?: number | null
  selectedEventId?: number | null
  onEventSelect?: (eventId: number) => void
}

function groupEventsByViewMode(events: TimelineEvent[], viewMode: ViewMode): Map<string, TimelineEvent[]> {
  const groups = new Map<string, TimelineEvent[]>()

  events.forEach((event) => {
    const eventDate = toValidDate(event.eventTime)
    if (!eventDate) return
    let key: string

    switch (viewMode) {
      case 'day':
        key = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(eventDate)
        break
      case 'week':
        const weekStart = startOfWeek(eventDate, { weekStartsOn: 1 })
        const weekEnd = endOfWeek(eventDate, { weekStartsOn: 1 })
        const weekNumber = getWeek(weekStart, { weekStartsOn: 1 })
        const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
        const yearFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric' })
        key = `${yearFormatter.format(weekStart)} Week ${weekNumber} (${dateFormatter.format(weekStart)} – ${dateFormatter.format(weekEnd)})`
        break
      case 'month':
        key = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(eventDate)
        break
      default:
        key = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(eventDate)
    }

    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(event)
  })

  return groups
}

export function TimelineView({
  events,
  onEdit,
  onDelete,
  onReferenceClick,
  onPlanReferenceClick,
  highlightEventId,
  highlightKey,
  selectedEventId,
  onEventSelect,
}: TimelineViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('day')
  const groups = useMemo(
    () => groupEventsByViewMode(events, viewMode),
    [events, viewMode],
  )

  return (
    <div className={styles.timeline}>
      <div className={styles.timelineHeader}>
        <div>
          <h2>Evidence timeline</h2>
          <p>
            {events.length > 0
              ? `${events.length} loaded · newest first`
              : 'No work items match the current filters'}
          </p>
        </div>
        <TimelineViewSwitcher viewMode={viewMode} onViewModeChange={setViewMode} />
      </div>

      {events.length === 0 ? (
        <div className={styles.emptyState}>
          <Inbox size={24} aria-hidden="true" />
          <strong>No work items match</strong>
          <span>Clear a filter, choose another day, or record a new work item above.</span>
        </div>
      ) : (
        <div className={styles.groups}>
          {Array.from(groups.entries()).map(([title, groupEvents]) => (
            <TimelineGroup
              key={title}
              title={title}
              events={groupEvents}
              onEdit={onEdit}
              onDelete={onDelete}
              onReferenceClick={onReferenceClick}
              onPlanReferenceClick={onPlanReferenceClick}
              highlightEventId={highlightEventId}
              highlightKey={highlightKey}
              selectedEventId={selectedEventId}
              onEventSelect={onEventSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
