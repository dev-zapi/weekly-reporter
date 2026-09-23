'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatSystemDateTime } from '@/lib/time-format'
import { ContentWithReferences } from './ContentWithReferences'

interface ReferencePreviewDialogProps {
  eventId: number | null
  onClose: () => void
  onLocate: (eventId: number) => void
}

interface EventData {
  id: number
  content: string
  eventTime: string
  source: string
  isImportant: boolean
  tags: string[]
}

export function ReferencePreviewDialog({ eventId, onClose, onLocate }: ReferencePreviewDialogProps) {
  const [event, setEvent] = useState<EventData | null>(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (eventId === null) {
      setEvent(null)
      setNotFound(false)
      return
    }

    setLoading(true)
    setNotFound(false)
    fetch(`/api/events/${eventId}`)
      .then((res) => {
        if (res.status === 404) {
          setNotFound(true)
          return null
        }
        return res.json()
      })
      .then((data) => {
        if (data) setEvent(data)
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [eventId])

  return (
    <Dialog open={eventId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {loading ? 'Loading…' : notFound ? 'Event Not Found' : event ? `Event #${event.id}` : ''}
          </DialogTitle>
          <DialogDescription>
            {loading ? 'Fetching event details…' : notFound ? 'This event does not exist or has been deleted.' : 'Reference preview'}
          </DialogDescription>
        </DialogHeader>

        {!loading && !notFound && event && (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {formatSystemDateTime(new Date(event.eventTime))}
              {event.source === 'manual' ? ' · Manual' : ` · ${event.source}`}
            </div>
            <div className="text-sm whitespace-pre-line border rounded-md p-3 bg-muted/50">
              <ContentWithReferences content={event.content} isManual={event.source === 'manual'} />
            </div>
            {event.tags.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {event.tags.map((tag) => (
                  <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={() => onLocate(event.id)}>
                Locate this event
              </Button>
            </div>
          </div>
        )}

        {notFound && (
          <div className="text-sm text-muted-foreground py-4">
            The referenced event (ID: {eventId}) does not exist. This is a dangling reference.
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
