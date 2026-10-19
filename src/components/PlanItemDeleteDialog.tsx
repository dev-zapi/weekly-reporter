'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatSystemDateTime } from '@/lib/time-format'
import type { PlanReferrerEvent } from '@/lib/plan-references/referrers'

type Props = {
  itemId: number | null
  onClose: () => void
  onConfirm: (id: number) => void
}

/**
 * Pre-deletion confirmation for a plan item. Before the caller deletes, this
 * lists the events that reference the item so the user sees the dangling
 * references they are about to create (ADR-0019). Read-only: it only reads
 * referrers, never mutates associations.
 */
export function PlanItemDeleteDialog({ itemId, onClose, onConfirm }: Props) {
  const [referrers, setReferrers] = useState<PlanReferrerEvent[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (itemId === null) {
      setReferrers([])
      return
    }

    const controller = new AbortController()
    setLoading(true)
    fetch(`/api/plan-items/${itemId}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load references')
        const data: { referrers?: PlanReferrerEvent[] } = await response.json()
        if (!controller.signal.aborted) setReferrers(data.referrers ?? [])
      })
      .catch(() => {
        if (!controller.signal.aborted) setReferrers([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [itemId])

  return (
    <Dialog open={itemId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete plan item?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div role="status" className="text-sm text-muted-foreground">Loading…</div>
        ) : referrers.length === 0 ? (
          <div className="text-sm text-muted-foreground">No events reference this item.</div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm">
              This item is referenced by {referrers.length}{' '}
              {referrers.length === 1 ? 'event' : 'events'}. Deleting it will leave
              dangling references:
            </div>
            <ul className="space-y-2">
              {referrers.map((referrer) => (
                <li key={referrer.id} className="rounded-md border bg-muted/40 p-2">
                  <div className="text-xs text-muted-foreground">
                    {formatSystemDateTime(referrer.eventTime)}
                  </div>
                  <div className="text-sm">{referrer.content}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (itemId !== null) onConfirm(itemId)
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
