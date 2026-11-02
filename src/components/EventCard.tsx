'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Edit2, Trash2, FileText, GitBranch, MessageSquare } from 'lucide-react'
import type { RawEvent } from '@/lib/db/schema'
import { EventTimestamp } from './EventTimestamp'
import { ContentWithReferences } from './ContentWithReferences'
import { HIGHLIGHT_DURATION_MS } from '@/lib/reference-constants'
import { buildPlansDeepLink } from '@/lib/plan-links'

interface EventCardProps {
  event: RawEvent
  /**
   * Number of plan item comments citing this event, supplied by the events
   * list query. Undefined/0 hides the cited-by marker.
   */
  commentReferrerCount?: number
  onEdit?: (id: number, data: Partial<RawEvent>) => Promise<void>
  onDelete?: (id: number) => Promise<void>
  onReferenceClick?: (referenceId: number) => void
  onPlanReferenceClick?: (planItemId: number) => void
  highlightKey?: number | null
}

interface CommentReferrerSummary {
  commentId: number
  planItemId: number
  excerpt: string
  author: string | null
  scope: 'week' | 'month'
  periodStart: string
}

export function EventCard({ event, commentReferrerCount, onEdit, onDelete, onReferenceClick, onPlanReferenceClick, highlightKey }: EventCardProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(event.content)
  const [loading, setLoading] = useState(false)
  const [locatingCitation, setLocatingCitation] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const isManual = event.source === 'manual'

  useEffect(() => {
    if (highlightKey && cardRef.current) {
      // Remove first so re-applying the same class re-triggers the animation.
      cardRef.current.classList.remove('reference-highlight')
      // Force reflow before re-adding the class.
      void cardRef.current.offsetWidth
      cardRef.current.classList.add('reference-highlight')
      const timer = setTimeout(() => {
        cardRef.current?.classList.remove('reference-highlight')
      }, HIGHLIGHT_DURATION_MS)
      return () => clearTimeout(timer)
    }
  }, [highlightKey])

  const handleSubmit = async () => {
    if (!onEdit) return

    const trimmed = editContent.trim()
    if (!trimmed) return

    setLoading(true)
    try {
      await onEdit(event.id, { content: trimmed })
      setEditing(false)
    } finally {
      setLoading(false)
    }
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: let the IME handle any key (Enter confirms candidate, Esc cancels candidate).
    // Must be the FIRST check so Esc/Enter during composition go to the IME, not to save/exit.
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setEditContent(event.content)
      setEditing(false)
      return
    }
    if (e.key === 'Enter' && !loading) {
      if (e.shiftKey) {
        return // textarea inserts a real \n naturally
      }
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleLocateCitation = async () => {
    if (locatingCitation) return
    setLocatingCitation(true)
    try {
      const res = await apiFetch(`/api/events/${event.id}/references`)
      if (!res.ok) return
      const data: { commentReferrers?: { comments?: CommentReferrerSummary[] } } = await res.json()
      const first = data.commentReferrers?.comments?.[0]
      if (first) {
        router.push(buildPlansDeepLink(first.scope, first.periodStart, first.planItemId))
      }
    } catch {
      // A failed lookup must not break the timeline; leave the user in place.
    } finally {
      setLocatingCitation(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete) return

    // Check which content surfaces reference this event: other events
    // (`@id` in manual events) and plan item comments (also `@id`).
    let referrers: Array<{ id: number; content: string }> = []
    let commentReferrers: CommentReferrerSummary[] = []
    try {
      const res = await apiFetch(`/api/events/${event.id}/references`)
      if (res.ok) {
        const data: {
          referrers?: Array<{ id: number; content: string }>
          commentReferrers?: { comments?: CommentReferrerSummary[] }
        } = await res.json()
        referrers = data.referrers || []
        commentReferrers = data.commentReferrers?.comments || []
      }
    } catch {
      // Ignore errors, proceed with deletion
    }

    const warnings: string[] = []
    if (referrers.length > 0) {
      const summaries = referrers.map((r) => {
        const snippet = r.content.length > 40 ? r.content.slice(0, 40) + '…' : r.content
        return `#${r.id}: "${snippet.replace(/\n/g, ' ')}"`
      }).join('\n')
      warnings.push(
        `This event is referenced by ${referrers.length} event(s). Deleting it will leave dangling references.\n\nReferrers:\n${summaries}`,
      )
    }
    if (commentReferrers.length > 0) {
      const summaries = commentReferrers.map((c) => {
        return `Comment #${c.commentId} on plan item %${c.planItemId}: "${c.excerpt}"`
      }).join('\n')
      warnings.push(
        `This event is cited by ${commentReferrers.length} plan item comment(s). Deleting it will leave dangling citations.\n\nCitations:\n${summaries}`,
      )
    }

    const message =
      warnings.length > 0
        ? `${warnings.join('\n\n')}\n\nContinue?`
        : 'Delete this record?'

    if (confirm(message)) {
      setLoading(true)
      try {
        await onDelete(event.id)
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div ref={cardRef} data-event-id={event.id} className="border rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 flex-1">
          {event.isImportant && (
            <div className="w-2 h-2 rounded-full bg-yellow-500 mt-2" />
          )}
          <div className="flex-1 space-y-2">
            {editing ? (
              <div className="relative space-y-2">
                <Textarea
                  ref={(el) => {
                    if (el) el.focus()
                  }}
                  rows={3}
                  className="resize-none overflow-y-auto field-sizing-fixed"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  disabled={loading}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSubmit} disabled={loading}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={loading}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-line">
                <ContentWithReferences
                  content={event.content}
                  isManual={isManual}
                  onReferenceClick={onReferenceClick}
                  onPlanReferenceClick={onPlanReferenceClick}
                />
              </p>
            )}

            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
              {isManual ? (
                <FileText className="h-3 w-3" />
              ) : (
                <GitBranch className="h-3 w-3" />
              )}
              <EventTimestamp event={event} />
              {typeof commentReferrerCount === 'number' && commentReferrerCount > 0 && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-5 gap-1 px-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => void handleLocateCitation()}
                    disabled={locatingCitation}
                    aria-label={`Cited by ${commentReferrerCount} ${
                      commentReferrerCount === 1 ? 'comment' : 'comments'
                    }`}
                  >
                    <MessageSquare className="h-3 w-3" />
                    Cited by {commentReferrerCount}{' '}
                    {commentReferrerCount === 1 ? 'comment' : 'comments'}
                  </Button>
                </>
              )}
              {event.metadata?.repo && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="font-medium text-foreground/70">{event.metadata.repo}</span>
                </>
              )}
              {event.metadata?.branch && (
                <span className="text-muted-foreground/70">⌊{event.metadata.branch}⌋</span>
              )}
              {event.metadata?.sourceName && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span
                    title={
                      event.metadata?.aliases && event.metadata.aliases.length > 0
                        ? `Aliases: ${event.metadata.aliases.join(', ')}`
                        : undefined
                    }
                  >
                    {event.metadata.sourceName}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {!editing && isManual && (
          <div className="flex gap-1">
            {onEdit && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={loading}>
                <Edit2 className="h-3 w-3" />
              </Button>
            )}
            {onDelete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDelete}
                disabled={loading}
                aria-label="Delete event"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
