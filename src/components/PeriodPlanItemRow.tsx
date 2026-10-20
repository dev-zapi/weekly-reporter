'use client'
import { apiFetch } from '@/lib/api-client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Trash2, Forward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatSystemDateTime } from '@/lib/time-format'
import { PlanItemDeleteDialog } from './PlanItemDeleteDialog'
import {
  PLAN_ITEM_STATUS_COLORS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUS_ORDER,
} from '@/lib/plan-item-display'
import type { PeriodPlanItem, PeriodPlanItemStatus, ProjectScope } from '@/lib/db/schema'

/** A plan item enriched by GET /api/plans with its chain-aggregated fulfillment count. */
export type PlanItemRowData = PeriodPlanItem & { fulfillmentCount?: number }

/** One fulfilling event as returned by GET /api/plan-items/[id]/fulfillment. */
type FulfillingEventView = {
  id: number
  content: string
  eventTime: string
  isManual: boolean
}

type Props = {
  item: PlanItemRowData
  parentOptions?: PeriodPlanItem[]
  showParentSelector?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  onUpdate: (id: number, updates: Partial<PeriodPlanItem>) => void
  onDelete: (id: number) => void
  onDefer: (id: number) => void
  onMove?: (id: number, direction: 'up' | 'down') => void
}

export function PeriodPlanItemRow({
  item,
  parentOptions = [],
  showParentSelector = false,
  canMoveUp = false,
  canMoveDown = false,
  onUpdate,
  onDelete,
  onDefer,
  onMove,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(item.text)
  const [expanded, setExpanded] = useState(false)
  const [events, setEvents] = useState<FulfillingEventView[] | null>(null)
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)

  // Lazily load fulfilling events on first expansion so the plans list stays
  // cheap for the common collapsed case.
  const handleToggleFulfillment = async () => {
    const next = !expanded
    setExpanded(next)
    if (!next || events !== null) return
    setEventsLoading(true)
    setEventsError(null)
    try {
      const response = await apiFetch(`/api/plan-items/${item.id}/fulfillment`)
      if (!response.ok) throw new Error('Failed to load fulfilling events')
      const data: { events?: FulfillingEventView[] } = await response.json()
      setEvents(data.events ?? [])
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Failed to load fulfilling events')
    } finally {
      setEventsLoading(false)
    }
  }

  const handleSaveEdit = () => {
    const next = editText.trim()
    if (next && next !== item.text) {
      onUpdate(item.id, { text: next })
    }
    setEditing(false)
  }

  const handleCancelEdit = () => {
    setEditText(item.text)
    setEditing(false)
  }

  // Deletion is confirmed through a dialog that first surfaces any events
  // referencing this item, so the user sees dangling references before deleting.
  const handleDelete = () => {
    setDeleteTarget(item.id)
  }

  const handleDefer = () => {
    if (window.confirm('Defer this item to the next period? The original will be marked as deferred.')) {
      onDefer(item.id)
    }
  }

  const handleStatusChange = (status: PeriodPlanItemStatus) => {
    onUpdate(item.id, { status })
  }

  const handleProjectScopeChange = (projectScope: ProjectScope) => {
    onUpdate(item.id, { projectScope })
  }

  const handleParentChange = (value: string) => {
    onUpdate(item.id, { parentItemId: value === '' ? null : Number(value) })
  }

  // Only incomplete items can be deferred (server enforces the same rule).
  const canDefer = item.status === 'planned' || item.status === 'in_progress'

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <div className="flex flex-col items-start gap-1">
        <Badge className={PLAN_ITEM_STATUS_COLORS[item.status]}>{PLAN_ITEM_STATUS_LABELS[item.status]}</Badge>
        <Badge variant="outline" className="font-mono text-xs">%{item.id}</Badge>
        {typeof item.fulfillmentCount === 'number' && (
          <Badge variant="secondary" className="text-xs">{item.fulfillmentCount} fulfilled</Badge>
        )}
      </div>

      <div className="flex-1 space-y-2">
        {editing ? (
          <div className="flex gap-2">
            <Input
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSaveEdit()
                if (event.key === 'Escape') handleCancelEdit()
              }}
              aria-label="Edit item text"
              autoFocus
            />
            <Button size="sm" onClick={handleSaveEdit}>
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={handleCancelEdit}>
              Cancel
            </Button>
          </div>
        ) : (
          <div
            className="cursor-pointer text-sm"
            onClick={() => setEditing(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setEditing(true)
            }}
            role="button"
            tabIndex={0}
          >
            {item.text}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleToggleFulfillment}
            aria-label="Toggle fulfillment events"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </Button>

          <select
            value={item.status}
            onChange={(event) => handleStatusChange(event.target.value as PeriodPlanItemStatus)}
            className="h-7 rounded border bg-transparent px-2 text-xs"
            aria-label="Status"
          >
            {PLAN_ITEM_STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {PLAN_ITEM_STATUS_LABELS[status]}
              </option>
            ))}
          </select>

          <select
            value={item.projectScope}
            onChange={(event) => handleProjectScopeChange(event.target.value as ProjectScope)}
            className="h-7 rounded border bg-transparent px-2 text-xs"
            aria-label="Project scope"
          >
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </select>

          {(showParentSelector || parentOptions.length > 0) && (
            <select
              value={item.parentItemId ?? ''}
              onChange={(event) => handleParentChange(event.target.value)}
              className="h-7 max-w-[12rem] rounded border bg-transparent px-2 text-xs"
              aria-label="Parent month item"
            >
              <option value="">No month parent</option>
              {parentOptions.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.text}
                </option>
              ))}
            </select>
          )}

          {onMove && (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onMove(item.id, 'up')}
                disabled={!canMoveUp}
                aria-label="Move up"
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onMove(item.id, 'down')}
                disabled={!canMoveDown}
                aria-label="Move down"
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
            </>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleDefer}
            disabled={!canDefer}
            title={canDefer ? 'Defer to next period' : 'Only incomplete items can be deferred'}
            aria-label="Defer to next period"
          >
            <Forward className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={handleDelete} aria-label="Delete item">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>

        {expanded && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-2">
            {eventsLoading ? (
              <div role="status" className="text-xs text-muted-foreground">Loading…</div>
            ) : eventsError ? (
              <div role="alert" className="text-xs text-destructive">{eventsError}</div>
            ) : !events || events.length === 0 ? (
              <div className="text-xs text-muted-foreground">No fulfilling events</div>
            ) : (
              <ul className="space-y-2">
                {events.map((event) => (
                  <li key={event.id} className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{formatSystemDateTime(event.eventTime)}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {event.isManual ? 'Manual' : 'Collected'}
                      </Badge>
                    </div>
                    <div className="text-sm line-clamp-2">{event.content}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <PlanItemDeleteDialog
        itemId={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={(id) => {
          onDelete(id)
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
