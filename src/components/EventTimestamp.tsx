'use client'

import type { RawEvent } from '@/lib/db/schema'
import { formatSystemDateTime, formatSystemRelativeTime } from '@/lib/time-format'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface EventTimestampProps {
  event: RawEvent
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const BACKDATED_THRESHOLD_MS = 60_000

function toMs(value: Date | string | number): number {
  const date = value instanceof Date ? value : new Date(value)
  return date.getTime()
}

function computeTooltipRows(event: RawEvent) {
  const isManual = event.source === 'manual'
  const eventTimeMs = toMs(event.eventTime)
  const createdAtMs = toMs(event.createdAt)
  const updatedAtMs = toMs(event.updatedAt)
  const nowMs = Date.now()
  const isRelative = nowMs - eventTimeMs <= TWO_HOURS_MS
  const backdated = Math.abs(createdAtMs - eventTimeMs) > BACKDATED_THRESHOLD_MS
  const modified = updatedAtMs > createdAtMs

  const visibleText = isRelative
    ? formatSystemRelativeTime(event.eventTime)
    : formatSystemDateTime(event.eventTime)

  const rows: string[] = []

  if (isManual) {
    if (isRelative) {
      rows.push(formatSystemDateTime(event.eventTime))
      if (backdated) rows.push(`Recorded: ${formatSystemDateTime(event.createdAt)}`)
      if (modified) rows.push(`Updated: ${formatSystemDateTime(event.updatedAt)}`)
    } else {
      // absolute time on card; only add incremental rows
      if (backdated) rows.push(`Recorded: ${formatSystemDateTime(event.createdAt)}`)
      if (modified) rows.push(`Updated: ${formatSystemDateTime(event.updatedAt)}`)
    }
  } else {
    // git event
    if (isRelative) {
      rows.push(`Authored: ${formatSystemDateTime(event.eventTime)}`)
    }
    rows.push(`Synced: ${formatSystemDateTime(event.createdAt)}`)
  }

  return { visibleText, rows, disabled: rows.length === 0 }
}

export function EventTimestamp({ event }: EventTimestampProps) {
  const { visibleText, rows, disabled } = computeTooltipRows(event)

  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger
        type="button"
        closeOnClick={false}
        className="bg-transparent p-0 border-0 text-inherit text-xs cursor-default h-auto font-normal"
      >
        <span suppressHydrationWarning>{visibleText}</span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          <div>ID: {event.id}</div>
          {rows.map((row, idx) => (
            <div key={idx}>{row}</div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
