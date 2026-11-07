import { apiFetch } from '@/lib/api-client'

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Edit2, Trash2, FileText, GitBranch, Link2, MessageSquare } from 'lucide-react'
import type { RawEvent } from '@/lib/db/schema'
import { EventTimestamp } from './EventTimestamp'
import { ContentWithReferences } from './ContentWithReferences'
import { HIGHLIGHT_DURATION_MS } from '@/lib/reference-constants'
import { buildPlansDeepLink } from '@/lib/plan-links'
import styles from './timeline.module.css'

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
  /** Whether this record is the one shown in the evidence trace. */
  selected?: boolean
  onSelect?: (eventId: number) => void
}

interface CommentReferrerSummary {
  commentId: number
  planItemId: number
  excerpt: string
  author: string | null
  scope: 'week' | 'month'
  periodStart: string
}

export function EventCard({
  event,
  commentReferrerCount,
  onEdit,
  onDelete,
  onReferenceClick,
  onPlanReferenceClick,
  highlightKey,
  selected = false,
  onSelect,
}: EventCardProps) {
  const navigate = useNavigate()
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
        navigate(buildPlansDeepLink(first.scope, first.periodStart, first.planItemId))
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

  const handleRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSelect || editing) return
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, textarea, select')) return
    onSelect(event.id)
  }

  return (
    <div
      ref={cardRef}
      data-event-id={event.id}
      onClick={handleRowClick}
      className={`${styles.eventRow} ${selected ? styles.eventRowSelected : ''}`}
    >
      <span className={styles.eventId}>@{event.id}</span>

      <div className={styles.eventBody}>
        {editing ? (
          <div className={styles.editForm}>
            <Textarea
              ref={(el) => {
                if (el) el.focus()
              }}
              rows={3}
              className={styles.editTextarea}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
              disabled={loading}
            />
            <div className={styles.editActions}>
              <Button size="sm" onClick={handleSubmit} disabled={loading}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={loading}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className={styles.eventTitle}>
            <ContentWithReferences
              content={event.content}
              isManual={isManual}
              onReferenceClick={onReferenceClick}
              onPlanReferenceClick={onPlanReferenceClick}
            />
          </p>
        )}

        <div className={styles.eventMeta}>
          {isManual ? (
            <FileText className="h-3 w-3" aria-hidden="true" />
          ) : (
            <GitBranch className="h-3 w-3" aria-hidden="true" />
          )}
          <EventTimestamp event={event} />
          {isManual && event.isImportant && (
            <span className={styles.importantFlag}>Important</span>
          )}
          {typeof commentReferrerCount === 'number' && commentReferrerCount > 0 && (
            <>
              <span className={styles.metaDivider} aria-hidden="true">·</span>
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
                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                Cited by {commentReferrerCount}{' '}
                {commentReferrerCount === 1 ? 'comment' : 'comments'}
              </Button>
            </>
          )}
          {event.metadata?.repo && (
            <>
              <span className={styles.metaDivider} aria-hidden="true">·</span>
              <span className={styles.eventRepo}>{event.metadata.repo}</span>
            </>
          )}
          {event.metadata?.branch && (
            <span className={styles.eventSource}>⌊{event.metadata.branch}⌋</span>
          )}
          {event.metadata?.sourceName && (
            <>
              <span className={styles.metaDivider} aria-hidden="true">·</span>
              <span
                className={styles.eventSourceName}
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

      <div className={styles.eventActions}>
        {!editing && onSelect && (
          <button
            type="button"
            className={styles.inspectButton}
            onClick={() => onSelect(event.id)}
            aria-pressed={selected}
            aria-label={`${selected ? 'Tracing' : 'Inspect'} event ${event.id}`}
          >
            <span className={styles.inspectLabel}>{selected ? 'Tracing' : 'Inspect'}</span>
            <Link2 size={14} aria-hidden="true" />
          </button>
        )}
        {!editing && isManual && (
          <>
            {onEdit && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setEditing(true)}
                disabled={loading}
                aria-label="Edit event"
              >
                <Edit2 className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={handleDelete}
                disabled={loading}
                aria-label="Delete event"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
