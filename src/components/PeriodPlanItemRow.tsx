'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Trash2, Forward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import type { PeriodPlanItem, PeriodPlanItemStatus, ProjectScope } from '@/lib/db/schema'

type Props = {
  item: PeriodPlanItem
  parentOptions?: PeriodPlanItem[]
  canMoveUp?: boolean
  canMoveDown?: boolean
  onUpdate: (id: number, updates: Partial<PeriodPlanItem>) => void
  onDelete: (id: number) => void
  onDefer: (id: number) => void
  onMove?: (id: number, direction: 'up' | 'down') => void
}

const statusColors: Record<PeriodPlanItemStatus, string> = {
  planned: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  deferred: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
}

const statusLabels: Record<PeriodPlanItemStatus, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
  deferred: 'Deferred',
}

const statusOrder: PeriodPlanItemStatus[] = ['planned', 'in_progress', 'done', 'cancelled', 'deferred']

export function PeriodPlanItemRow({
  item,
  parentOptions = [],
  canMoveUp = false,
  canMoveDown = false,
  onUpdate,
  onDelete,
  onDefer,
  onMove,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(item.text)

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

  const handleDelete = () => {
    if (window.confirm('Delete this plan item? This cannot be undone.')) {
      onDelete(item.id)
    }
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
      <Badge className={statusColors[item.status]}>{statusLabels[item.status]}</Badge>

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
          <select
            value={item.status}
            onChange={(event) => handleStatusChange(event.target.value as PeriodPlanItemStatus)}
            className="h-7 rounded border bg-transparent px-2 text-xs"
            aria-label="Status"
          >
            {statusOrder.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
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

          {parentOptions.length > 0 && (
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
      </div>
    </div>
  )
}
