'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Forward,
  MessageSquare,
  Paperclip,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatSystemDateTime } from '@/lib/time-format'
import { buildPlansDeepLink } from '@/lib/plan-links'
import { PlanItemDeleteDialog } from './PlanItemDeleteDialog'
import { ReferencePreviewDialog } from './ReferencePreviewDialog'
import { ContentWithReferences } from './ContentWithReferences'
import {
  PLAN_ITEM_PRIORITY_LABELS,
  PLAN_ITEM_PRIORITY_ORDER,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUS_ORDER,
} from '@/lib/plan-item-display'
import styles from './plan-surface.module.css'
import type {
  PeriodPlanItem,
  PeriodPlanItemPriority,
  PeriodPlanItemStatus,
  ProjectScope,
} from '@/lib/db/schema'

/** An attached week item as composed by the month-scope plans response. */
export type PlanChildItemData = {
  id: number
  text: string
  status: PeriodPlanItemStatus
  projectScope: ProjectScope
  priority: PeriodPlanItemPriority
  isImportant: boolean
  isUrgent: boolean
  weekPeriodStart: string
  weekPeriodEnd: string
  fulfillmentCount: number
  commentCount: number
}

/**
 * A week item attached to a deferral-chain ancestor's month item. The
 * successor renders it as a read-only group so the ancestor month's evidence
 * is inspectable in place; the item stays owned by that earlier month.
 */
export type PlanInheritedChildItem = Omit<PlanChildItemData, 'commentCount'>

/** One ancestor month's inherited week items. */
export type PlanInheritedChildGroup = {
  ancestorItemId: number
  ancestorMonth: string
  items: PlanInheritedChildItem[]
}

/** An unparented week item offered by the month-scope attach candidates. */
export type AttachCandidateItem = {
  id: number
  text: string
  status: PeriodPlanItemStatus
  projectScope: ProjectScope
  priority: PeriodPlanItemPriority
  isImportant: boolean
  isUrgent: boolean
}

/** One week's unparented items, as grouped by the month-scope response. */
export type AttachCandidateWeek = {
  periodStart: string
  periodEnd: string
  items: AttachCandidateItem[]
}

/**
 * The fields a row renders. Month-scope items carry composed counts and their
 * attached week items; attached week items carry their week attribution.
 */
export type PlanRowItem = Pick<
  PeriodPlanItem,
  'id' | 'text' | 'status' | 'priority' | 'isImportant' | 'isUrgent' | 'projectScope'
> & {
  parentItemId?: number | null
  deferredFromItemId?: number | null
  periodPlanId?: number
  position?: number
  fulfillmentCount?: number
  commentCount?: number
  directFulfillmentCount?: number
  indirectFulfillmentCount?: number
  childItems?: PlanChildItemData[]
  inheritedChildGroups?: PlanInheritedChildGroup[]
  weekPeriodStart?: string
  weekPeriodEnd?: string
}

/** A plan item enriched by GET /api/plans with its chain-aggregated counts. */
export type PlanItemRowData = PlanRowItem

/** One plan-side comment as returned by the comments collection endpoint. */
export type PlanCommentView = {
  id: number
  planItemId: number
  content: string
  /** null for browser-authored comments (rendered as 用户). */
  author: string | null
  createdAt: string
  /**
   * The period of the item this comment is pinned to. Present on every
   * aggregated comment; the UI only shows it for deferral-chain ancestors.
   */
  sourcePeriod?: {
    scope: 'week' | 'month'
    periodStart: string
    periodEnd: string
    monthKey: string | null
    label: string
  }
}

/** One fulfilling event as returned by GET /api/plan-items/[id]/fulfillment. */
type FulfillingEventView = {
  id: number
  content: string
  eventTime: string
  isManual: boolean
}

type Props = {
  item: PlanRowItem
  parentOptions?: PlanRowItem[]
  showParentSelector?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  onUpdate: (id: number, updates: Partial<PeriodPlanItem>) => void
  onDelete: (id: number) => void
  onDefer: (id: number) => void
  onMove?: (id: number, direction: 'up' | 'down') => void
  /**
   * Month scope: the month's unparented week items grouped by week. The picker
   * on each monthly item attaches one of them via the existing update endpoint.
   */
  attachCandidates?: AttachCandidateWeek[]
  onAttach?: (childId: number, parentItemId: number) => void
  /**
   * Month scope: the month's items, offered to an attached week item so it can
   * be detached or re-parented in place.
   */
  childParentOptions?: PlanRowItem[]
  /**
   * Render the row for review only: fulfillment expansion and the week deep
   * link stay available, but operation controls are hidden. Used for week
   * items inherited from a deferred ancestor's month.
   */
  readOnly?: boolean
  /**
   * Expand and highlight the comment section on mount. Set by the plans page
   * when a deep link targets this item (event-side cited-by locate).
   */
  autoExpandComments?: boolean
  /**
   * Report a locally loaded or mutated comment count upward. The listing
   * payload owns the badge fallback a row shows before its section expands —
   * and a week child row unmounts with its group, losing local state — so the
   * payload must not go stale after an in-row append or delete.
   */
  onCommentCountChange?: (id: number, count: number) => void
  /** The item selected in the persistent context inspector. */
  selectedItemId?: number | null
  /** Select this item in the persistent context inspector. */
  onSelect?: (id: number) => void
  /** Sequential position in the composed list, shown as the row number. */
  ordinal?: number
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
  attachCandidates = [],
  onAttach,
  childParentOptions = [],
  autoExpandComments = false,
  onCommentCountChange,
  readOnly = false,
  selectedItemId = null,
  onSelect,
  ordinal,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(item.text)
  const [expanded, setExpanded] = useState(false)
  const [events, setEvents] = useState<FulfillingEventView[] | null>(null)
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  // Deep links start with the comment section already open; the effect below
  // fills it in. Keeping this in the initial state avoids a synchronous
  // setState in an effect (cascading-render lint).
  const [commentsExpanded, setCommentsExpanded] = useState(autoExpandComments)
  const [comments, setComments] = useState<PlanCommentView[] | null>(null)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  // Comment citations open a read-only event preview; there is no timeline
  // filter to locate into from the plans page.
  const [previewEventId, setPreviewEventId] = useState<number | null>(null)
  // Attached week items are eager in the month-scope payload, so revealing
  // them is a local toggle; only their fulfilling events load lazily.
  const [childrenExpanded, setChildrenExpanded] = useState(false)
  const [inheritedExpanded, setInheritedExpanded] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)

  // Attached week items render through this same component in a read-only
  // shape: they carry their week attribution instead of month-item controls.
  const isWeekChild =
    typeof item.weekPeriodStart === 'string' && typeof item.weekPeriodEnd === 'string'
  const selected = selectedItemId === item.id

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
      if (!response.ok) throw new Error('Failed to load fulfilling events' + traceSuffix(response))
      const data: { events?: FulfillingEventView[] } = await response.json()
      setEvents(data.events ?? [])
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Failed to load fulfilling events')
    } finally {
      setEventsLoading(false)
    }
  }

  // Comments are lazily loaded on first expansion, mirroring fulfilling events.
  const loadComments = useCallback(async () => {
    setCommentsLoading(true)
    setCommentsError(null)
    try {
      const response = await apiFetch(`/api/plan-items/${item.id}/comments`)
      if (!response.ok) throw new Error('Failed to load comments' + traceSuffix(response))
      const data: { comments?: PlanCommentView[] } = await response.json()
      setComments(data.comments ?? [])
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : 'Failed to load comments')
    } finally {
      setCommentsLoading(false)
    }
  }, [item.id])

  const handleToggleComments = async () => {
    const next = !commentsExpanded
    setCommentsExpanded(next)
    if (!next || comments !== null) return
    await loadComments()
  }

  // Deep link: open the comment section without a click, then scroll it into
  // view. The section also carries the highlight animation class while
  // autoExpandComments is set.
  const commentsSectionRef = useRef<HTMLDivElement>(null)
  const autoExpandedRef = useRef(false)

  useEffect(() => {
    if (!autoExpandComments || autoExpandedRef.current) return
    autoExpandedRef.current = true
    // Load on a microtask so the effect body never sets state synchronously.
    void Promise.resolve().then(loadComments)
  }, [autoExpandComments, loadComments])

  useEffect(() => {
    if (!autoExpandComments) return
    const timer = setTimeout(() => {
      commentsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    return () => clearTimeout(timer)
  }, [autoExpandComments])

  // The badge must match what expansion shows, so a locally loaded list wins
  // over the server-provided count after an append or delete.
  const displayCommentCount = comments !== null ? comments.length : item.commentCount

  // Sync loaded/mutated counts into the listing payload (see the prop doc):
  // the manager owns the fallback a remounted row renders.
  useEffect(() => {
    if (comments !== null) onCommentCountChange?.(item.id, comments.length)
  }, [comments, item.id, onCommentCountChange])

  const handleSubmitComment = async () => {
    const content = commentDraft.trim()
    if (!content || commentSubmitting) return
    setCommentSubmitting(true)
    setCommentsError(null)
    try {
      const response = await apiFetch(`/api/plan-items/${item.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!response.ok) throw new Error('Failed to add comment' + traceSuffix(response))
      const created: PlanCommentView = await response.json()
      setComments((prev) => (prev === null ? [created] : [...prev, created]))
      setCommentDraft('')
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : 'Failed to add comment')
    } finally {
      setCommentSubmitting(false)
    }
  }

  const handleCommentKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition must be checked first so Enter confirming a candidate
    // never submits the comment.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSubmitComment()
    }
  }

  const handleDeleteComment = async (commentId: number) => {
    if (!window.confirm('Delete this comment?')) return
    try {
      const response = await apiFetch(`/api/plan-items/${item.id}/comments/${commentId}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error('Failed to delete comment' + traceSuffix(response))
      const data: { deleted?: boolean } = await response.json()
      if (data.deleted === false) throw new Error('Failed to delete comment' + traceSuffix(response))
      setComments((prev) => (prev ? prev.filter((comment) => comment.id !== commentId) : prev))
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : 'Failed to delete comment')
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

  const handlePriorityChange = (priority: PeriodPlanItemPriority) => {
    onUpdate(item.id, { priority })
  }

  const handleImportantToggle = () => {
    onUpdate(item.id, { isImportant: !item.isImportant })
  }

  const handleUrgentToggle = () => {
    onUpdate(item.id, { isUrgent: !item.isUrgent })
  }

  const handleProjectScopeChange = (projectScope: ProjectScope) => {
    onUpdate(item.id, { projectScope })
  }

  const handleParentChange = (value: string) => {
    onUpdate(item.id, { parentItemId: value === '' ? null : Number(value) })
  }

  // Only incomplete items can be deferred (server enforces the same rule).
  const canDefer = item.status === 'planned' || item.status === 'in_progress'
  const hasSplit =
    typeof item.directFulfillmentCount === 'number' &&
    typeof item.indirectFulfillmentCount === 'number'

  return (
    <div className={styles.row} data-selected={selected ? 'true' : 'false'}>
      <button
        type="button"
        className={styles.rowIndex}
        onClick={() => onSelect?.(item.id)}
        aria-label={`Inspect plan item %${item.id}`}
        aria-pressed={selected}
      >
        {typeof ordinal === 'number' && <span className={styles.indexNumber}>{ordinal}</span>}
        <span className={styles.itemId}>%{item.id}</span>
      </button>

      <div className={styles.rowBody}>
        <div className={styles.rowHeading}>
          <div className={styles.rowTitleBlock}>
            {isWeekChild ? (
              <div className={styles.rowStaticText}>{item.text}</div>
            ) : editing ? (
              <div className={styles.composerRow}>
                <input
                  className={styles.textInput}
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleSaveEdit()
                    if (event.key === 'Escape') handleCancelEdit()
                  }}
                  aria-label="Edit item text"
                  autoFocus
                />
                <button type="button" className={styles.primaryButton} onClick={handleSaveEdit}>
                  Save
                </button>
                <button type="button" className={styles.secondaryButton} onClick={handleCancelEdit}>
                  Cancel
                </button>
              </div>
            ) : (
              <div
                className={styles.rowText}
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

            <div className={styles.rowBadges}>
              <span className={styles.badge} data-status={item.status}>
                {PLAN_ITEM_STATUS_LABELS[item.status]}
              </span>
              {item.isImportant && (
                <span className={styles.badge} data-tone="important">Important</span>
              )}
              {item.isUrgent && (
                <span className={styles.badge} data-tone="urgent">Urgent</span>
              )}
              {typeof item.fulfillmentCount === 'number' && (
                <span className={`${styles.badge} ${styles.badgeEvidence}`}>
                  {item.fulfillmentCount} fulfilled
                </span>
              )}
              {typeof displayCommentCount === 'number' && (
                <span className={`${styles.badge} ${styles.badgeComment}`}>
                  {displayCommentCount} comments
                </span>
              )}
            </div>

            <div className={styles.rowMeta}>
              <span>{PLAN_ITEM_PRIORITY_LABELS[item.priority]} priority</span>
              <span>{item.projectScope === 'work' ? 'Work' : 'Personal'} scope</span>
              {hasSplit && (
                <span>
                  {item.directFulfillmentCount} direct · {item.indirectFulfillmentCount} indirect
                </span>
              )}
              {isWeekChild && item.weekPeriodStart && item.weekPeriodEnd && (
                <Link
                  href={buildPlansDeepLink('week', item.weekPeriodStart)}
                  className={styles.weekLink}
                >
                  Week {item.weekPeriodStart} - {item.weekPeriodEnd}
                </Link>
              )}
            </div>
          </div>

          {/* Inherited rows are review-only: the status badge stays visible,
              while the write control is omitted. */}
          {!readOnly && (
            <label className={styles.statusField}>
              <span className={styles.statusLabel}>Status</span>
              <select
                value={item.status}
                onChange={(event) => handleStatusChange(event.target.value as PeriodPlanItemStatus)}
                className={styles.compactSelect}
                aria-label={`Status for %${item.id}`}
              >
                {PLAN_ITEM_STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {PLAN_ITEM_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className={styles.rowEvidence}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={handleToggleFulfillment}
            aria-label="Toggle fulfillment events"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Evidence
          </button>
          {!readOnly && (
            <button
              type="button"
              className={styles.controlButton}
              onClick={handleToggleComments}
              aria-label="Toggle comments"
              aria-expanded={commentsExpanded}
            >
              <MessageSquare size={13} />
              Comments
            </button>
          )}
        </div>

        {!readOnly && (
          <div className={styles.rowControls}>
            {/* Attached week items detach or re-parent in place through the same
                parent-link update the week tab uses. */}
            {isWeekChild && parentOptions.length > 0 && (
              <select
                value={item.parentItemId ?? ''}
                onChange={(event) => handleParentChange(event.target.value)}
                className={styles.rowSelect}
                aria-label={`Parent month item for %${item.id}`}
              >
                <option value="">No month parent</option>
                {parentOptions.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.text}
                  </option>
                ))}
              </select>
            )}

            {/* Operation parity (status, priority, flags, scope, defer, delete):
                both monthly items and attached week items write through the same
                plan-item endpoints. */}
            <select
              value={item.priority}
              onChange={(event) => handlePriorityChange(event.target.value as PeriodPlanItemPriority)}
              className={styles.rowSelect}
              aria-label={`Priority for %${item.id}`}
            >
              {PLAN_ITEM_PRIORITY_ORDER.map((priority) => (
                <option key={priority} value={priority}>
                  {PLAN_ITEM_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>

            <button
              type="button"
              className={styles.controlButton}
              aria-label="Toggle plan item important flag"
              aria-pressed={item.isImportant}
              onClick={handleImportantToggle}
            >
              Important
            </button>

            <button
              type="button"
              className={styles.controlButton}
              aria-label="Toggle plan item urgent flag"
              aria-pressed={item.isUrgent}
              onClick={handleUrgentToggle}
            >
              Urgent
            </button>

            <select
              value={item.projectScope}
              onChange={(event) => handleProjectScopeChange(event.target.value as ProjectScope)}
              className={styles.rowSelect}
              aria-label={`Project scope for %${item.id}`}
            >
              <option value="work">Work</option>
              <option value="personal">Personal</option>
            </select>

            {!isWeekChild && (showParentSelector || parentOptions.length > 0) && (
              <select
                value={item.parentItemId ?? ''}
                onChange={(event) => handleParentChange(event.target.value)}
                className={styles.rowSelect}
                aria-label={`Parent month item for %${item.id}`}
              >
                <option value="">No month parent</option>
                {parentOptions.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.text}
                  </option>
                ))}
              </select>
            )}

            {!isWeekChild && onMove && (
              <>
                <button
                  type="button"
                  className={styles.iconControl}
                  onClick={() => onMove(item.id, 'up')}
                  disabled={!canMoveUp}
                  aria-label="Move up"
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className={styles.iconControl}
                  onClick={() => onMove(item.id, 'down')}
                  disabled={!canMoveDown}
                  aria-label="Move down"
                >
                  <ArrowDown size={13} />
                </button>
              </>
            )}

            <button
              type="button"
              className={styles.iconControl}
              onClick={handleDefer}
              disabled={!canDefer}
              title={canDefer ? 'Defer to next period' : 'Only incomplete items can be deferred'}
              aria-label="Defer to next period"
            >
              <Forward size={13} />
            </button>
            <button
              type="button"
              className={styles.iconControl}
              onClick={handleDelete}
              aria-label="Delete item"
            >
              <Trash2 size={13} />
            </button>

            {/* Attaching a week item is month-side only; attached week items keep
                the shared operation controls above. */}
            {!isWeekChild && onAttach && (
              <button
                type="button"
                className={styles.controlButton}
                aria-label="Attach week item"
                onClick={() => setAttachOpen(true)}
              >
                <Paperclip size={13} />
                Attach
              </button>
            )}
          </div>
        )}

        {!isWeekChild && Array.isArray(item.childItems) && (
          <div className={styles.childrenPanel}>
            <button
              type="button"
              className={styles.controlButton}
              onClick={() => setChildrenExpanded((prev) => !prev)}
              aria-label="Toggle attached week items"
              aria-expanded={childrenExpanded}
            >
              {childrenExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Attached week items ({item.childItems.length})
            </button>

            {childrenExpanded && (
              item.childItems.length === 0 ? (
                <div className={styles.mutedText}>No attached week items</div>
              ) : (
                <div className={styles.childrenList}>
                  {item.childItems.map((child) => (
                    <div key={child.id} role="group" aria-label={`Week item ${child.text}`} className={styles.childGroup}>
                      <PeriodPlanItemRow
                        item={{ ...child, parentItemId: item.id }}
                        parentOptions={childParentOptions}
                        onUpdate={onUpdate}
                        onDelete={onDelete}
                        onDefer={onDefer}
                        onCommentCountChange={onCommentCountChange}
                        selectedItemId={selectedItemId}
                        onSelect={onSelect}
                      />
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        )}

        {!isWeekChild && Array.isArray(item.inheritedChildGroups) && item.inheritedChildGroups.length > 0 && (
          <div className={styles.childrenPanel}>
            <button
              type="button"
              className={styles.controlButton}
              onClick={() => setInheritedExpanded((prev) => !prev)}
              aria-label="Toggle inherited week items"
              aria-expanded={inheritedExpanded}
            >
              {inheritedExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Inherited week items (
              {item.inheritedChildGroups.reduce((total, group) => total + group.items.length, 0)})
            </button>

            {inheritedExpanded && (
              <div className={styles.childrenList}>
                {item.inheritedChildGroups.map((group) => (
                  <div
                    key={group.ancestorItemId}
                    role="group"
                    aria-label={`Inherited from ${group.ancestorMonth}`}
                    className={styles.inheritedGroup}
                  >
                    <div className={styles.inheritedLabel}>From {group.ancestorMonth}</div>
                    {group.items.map((child) => (
                      <div key={child.id} role="group" aria-label={`Inherited week item ${child.text}`}>
                        <PeriodPlanItemRow
                          item={child}
                          onUpdate={onUpdate}
                          onDelete={onDelete}
                          onDefer={onDefer}
                          selectedItemId={selectedItemId}
                          onSelect={onSelect}
                          readOnly
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {expanded && (
          <div className={styles.subpanel}>
            {eventsLoading ? (
              <div role="status" className={styles.mutedText}>Loading…</div>
            ) : eventsError ? (
              <div role="alert" className={styles.errorText}>{eventsError}</div>
            ) : !events || events.length === 0 ? (
              <div className={styles.mutedText}>No fulfilling events</div>
            ) : (
              <ul className={styles.eventList}>
                {events.map((event) => (
                  <li key={event.id} className={styles.eventItem}>
                    <div className={styles.itemMeta}>
                      <span>{formatSystemDateTime(event.eventTime)}</span>
                      <span className={styles.badge}>
                        {event.isManual ? 'Manual' : 'Collected'}
                      </span>
                    </div>
                    <div className={`${styles.itemBody} ${isWeekChild ? '' : styles.itemBodyClamp}`}>
                      {event.content}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {commentsExpanded && (
          <div
            ref={commentsSectionRef}
            className={`${styles.subpanel} ${autoExpandComments ? 'reference-highlight' : ''}`}
          >
            {commentsLoading ? (
              <div role="status" className={styles.mutedText}>Loading…</div>
            ) : commentsError ? (
              <div role="alert" className={styles.errorText}>{commentsError}</div>
            ) : !comments || comments.length === 0 ? (
              <div className={styles.mutedText}>No comments</div>
            ) : (
              <ul className={styles.commentList}>
                {comments.map((comment) => {
                  // Comments stay pinned to the item they were written on. In a
                  // deferred successor they appear aggregated with their source
                  // period and cannot be deleted from here.
                  const isAncestorComment = comment.planItemId !== item.id
                  return (
                    <li key={comment.id} className={styles.commentItem}>
                      <div className={styles.itemMeta}>
                        <strong>{comment.author ?? '用户'}</strong>
                        <span>{formatSystemDateTime(comment.createdAt)}</span>
                        {isAncestorComment && comment.sourcePeriod && (
                          <span className={styles.badge}>{comment.sourcePeriod.label}</span>
                        )}
                        {!isAncestorComment && (
                          <button
                            type="button"
                            className={styles.iconControl}
                            onClick={() => void handleDeleteComment(comment.id)}
                            aria-label={`Delete comment ${comment.id}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                      <div className={styles.commentBody}>
                        <ContentWithReferences
                          content={comment.content}
                          eventReferencesOnly
                          onReferenceClick={(referenceId) => setPreviewEventId(referenceId)}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className={styles.commentComposer}>
              <textarea
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                onKeyDown={handleCommentKeyDown}
                aria-label="New comment"
                placeholder="Add a comment… (Enter to post, Shift+Enter for a newline)"
                className={styles.commentTextarea}
              />
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void handleSubmitComment()}
                disabled={!commentDraft.trim() || commentSubmitting}
              >
                Comment
              </button>
            </div>
          </div>
        )}
      </div>

      {!isWeekChild && onAttach && (
        <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Attach week item</DialogTitle>
              <DialogDescription>
                Only unparented week items from the weeks of this month are listed.
              </DialogDescription>
            </DialogHeader>

            {attachCandidates.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No unparented week items in this month.
              </div>
            ) : (
              <div className="space-y-3">
                {attachCandidates.map((week) => (
                  <div
                    key={week.periodStart}
                    role="group"
                    aria-label={`Week ${week.periodStart} - ${week.periodEnd}`}
                    className="space-y-1"
                  >
                    <div className="text-xs font-medium text-muted-foreground">
                      Week {week.periodStart} - {week.periodEnd}
                    </div>
                    {week.items.map((candidate) => (
                      <Button
                        key={candidate.id}
                        variant="ghost"
                        size="sm"
                        className="flex h-auto w-full justify-start px-2 py-1 text-left text-sm"
                        onClick={() => {
                          onAttach(candidate.id, item.id)
                          setAttachOpen(false)
                        }}
                      >
                        {candidate.text}
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      <ReferencePreviewDialog
        eventId={previewEventId}
        onClose={() => setPreviewEventId(null)}
      />

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
