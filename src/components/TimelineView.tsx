'use client'

import { useState, useEffect } from 'react'
import { startOfWeek, endOfWeek, getWeek } from 'date-fns'
import { TimelineViewSwitcher } from './TimelineViewSwitcher'
import { TimelineGroup } from './TimelineGroup'
import type { RawEvent } from '@/lib/db/schema'
import { toValidDate } from '@/lib/time-format'

type ViewMode = 'day' | 'week' | 'month'

interface TimelineViewProps {
  events: RawEvent[]
  onEdit?: (id: number, data: Partial<RawEvent>) => Promise<void>
  onDelete?: (id: number) => Promise<void>
  onReferenceClick?: (referenceId: number) => void
  highlightEventId?: number | null
  highlightKey?: number | null
}

function groupEventsByViewMode(events: RawEvent[], viewMode: ViewMode): Map<string, RawEvent[]> {
  const groups = new Map<string, RawEvent[]>()
  
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

export function TimelineView({ events, onEdit, onDelete, onReferenceClick, highlightEventId, highlightKey }: TimelineViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('day')
  const [groups, setGroups] = useState<Map<string, RawEvent[]>>(new Map())
  
  useEffect(() => {
    const grouped = groupEventsByViewMode(events, viewMode)
    setGroups(grouped)
  }, [events, viewMode])
  
  return (
    <div className="space-y-4">
      <TimelineViewSwitcher viewMode={viewMode} onViewModeChange={setViewMode} />
      
      <div className="space-y-6">
        {Array.from(groups.entries()).map(([title, groupEvents]) => (
          <TimelineGroup
            key={title}
            title={title}
            events={groupEvents}
            onEdit={onEdit}
            onDelete={onDelete}
            onReferenceClick={onReferenceClick}
            highlightEventId={highlightEventId}
            highlightKey={highlightKey}
          />
        ))}
      </div>
    </div>
  )
}
