'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  startOfWeek,
} from 'date-fns'
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
} from 'lucide-react'
import {
  PeriodPlanItemRow,
  type AttachCandidateWeek,
  type PlanChildItemData,
  type PlanItemRowData,
} from './PeriodPlanItemRow'
import { PlanContextPanel } from './PlanContextPanel'
import { getWeekPeriodRange, getMonthPeriodRange } from '@/lib/periods'
import {
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUS_ORDER,
} from '@/lib/plan-item-display'
import styles from './plan-surface.module.css'
import type { PeriodPlan, PeriodPlanItem, PeriodPlanScope } from '@/lib/db/schema'

type PlanResponse = {
  plan: PeriodPlan | null
  items: PlanItemRowData[]
  attachCandidates?: AttachCandidateWeek[]
}

type PeriodParams = Record<string, string>

type Props = {
  initialScope?: PeriodPlanScope
  initialStart?: string | null
  /** Deep link from the event-side cited-by marker: expand this item's comments. */
  initialItemId?: number | null
}

// The deep-link start is a yyyy-MM-dd period start; parse it as a local date.
function parsePeriodStart(start: string | null | undefined): Date | null {
  if (!start) return null
  const date = new Date(`${start}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The Monday-start weeks attributed to a month: weeks whose start day falls
 * inside the month range. This mirrors the server's derived week→month
 * attribution, so a week starting in an adjacent month is never offered.
 */
function getMonthWeekOptions(date: Date): Array<{ start: string; end: string }> {
  const month = getMonthPeriodRange(date)
  const firstMonday = startOfWeek(new Date(`${month.start}T00:00:00`), { weekStartsOn: 1 })
  const weeks: Array<{ start: string; end: string }> = []
  for (let cursor = firstMonday; ; cursor = addWeeks(cursor, 1)) {
    const range = getWeekPeriodRange(cursor)
    if (range.start > month.end) break
    if (range.start >= month.start) weeks.push(range)
  }
  return weeks
}

/**
 * Merge a PUT response into an attached week item, preserving the fields the
 * aggregated month payload owns (week attribution and composed counts).
 */
function mergeChildRow(child: PlanChildItemData, updated: PeriodPlanItem): PlanChildItemData {
  return {
    ...child,
    ...updated,
    id: child.id,
    weekPeriodStart: child.weekPeriodStart,
    weekPeriodEnd: child.weekPeriodEnd,
    fulfillmentCount: child.fulfillmentCount,
    commentCount: child.commentCount,
  }
}

// Items are grouped by priority on the server, so an item can only be
// reordered against its immediate neighbour when that neighbour belongs to the
// same priority group. Group heads/tails therefore have no move target.
function sameGroupNeighbour(
  items: PlanItemRowData[],
  index: number,
  direction: 'up' | 'down'
): number | null {
  const neighbour = direction === 'up' ? index - 1 : index + 1
  if (neighbour < 0 || neighbour >= items.length) return null
  return items[neighbour].priority === items[index].priority ? neighbour : null
}

/** Resolve a top-level, attached, or inherited row for the context inspector. */
function findPlanItem(items: PlanItemRowData[], id: number): PlanItemRowData | null {
  for (const item of items) {
    if (item.id === id) return item
    const child = item.childItems?.find((candidate) => candidate.id === id)
    if (child) return child
    for (const group of item.inheritedChildGroups ?? []) {
      const inherited = group.items.find((candidate) => candidate.id === id)
      if (inherited) return inherited
    }
  }
  return null
}

export function PeriodPlanManager({ initialScope = 'week', initialStart = null, initialItemId = null }: Props = {}) {
  const [scope, setScope] = useState<PeriodPlanScope>(initialScope)
  const [currentDate, setCurrentDate] = useState<Date>(() => parsePeriodStart(initialStart) ?? new Date())
  const [items, setItems] = useState<PlanItemRowData[]>([])
  const [parentOptions, setParentOptions] = useState<PlanItemRowData[]>([])
  // Month scope: the month's unparented week items grouped by week, straight
  // from the aggregated response. Week scope never uses them.
  const [attachCandidates, setAttachCandidates] = useState<AttachCandidateWeek[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newItemText, setNewItemText] = useState('')
  // Week-targeted creation inside the month review: a new week item lands in
  // the chosen week's plan without leaving the view.
  const [newWeekItemText, setNewWeekItemText] = useState('')
  const [targetWeekStart, setTargetWeekStart] = useState('')
  // The persistent context/inspector follows this selection. Without one, the
  // first item (or the deep-linked item) is the effective selection.
  const [selectedItemId, setSelectedItemId] = useState<number | null>(initialItemId)

  // Derive the period parameters used by both the read and write endpoints.
  const getPeriodParams = useCallback((): PeriodParams => {
    if (scope === 'week') {
      const range = getWeekPeriodRange(currentDate)
      return {
        scope: 'week',
        weekStart: range.start,
        weekEnd: range.end,
      }
    }
    return {
      scope: 'month',
      month: getMonthPeriodRange(currentDate).monthKey,
    }
  }, [scope, currentDate])

  // The month's attributed weeks, offered as creation targets in month scope.
  const weekOptions = useMemo(
    () => (scope === 'month' ? getMonthWeekOptions(currentDate) : []),
    [scope, currentDate]
  )
  const targetWeek =
    weekOptions.find((week) => week.start === targetWeekStart) ?? weekOptions[0] ?? null

  const fetchPlan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams(getPeriodParams()).toString()
      const response = await apiFetch(`/api/plans?${query}`)
      if (!response.ok) throw new Error('Failed to load plan' + traceSuffix(response))
      const data: PlanResponse = await response.json()
      setItems(data.items)
      setAttachCandidates(data.attachCandidates ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plan')
    } finally {
      setLoading(false)
    }
  }, [getPeriodParams])

  useEffect(() => {
    const loadPlan = async () => {
      await fetchPlan()
    }
    void loadPlan()
  }, [fetchPlan])

  // In week scope, offer month items as parent candidates. The parent month is
  // the calendar month that contains the week's start day.
  useEffect(() => {
    if (scope !== 'week') return
    const controller = new AbortController()
    const month = getWeekPeriodRange(currentDate).start.slice(0, 7)
    void apiFetch(`/api/plans?scope=month&month=${month}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load parent options')
        const data: PlanResponse = await response.json()
        if (!controller.signal.aborted) setParentOptions(data.items)
      })
      .catch(() => {
        if (!controller.signal.aborted) setParentOptions([])
      })
    return () => controller.abort()
  }, [scope, currentDate])

  const handleAddItem = async () => {
    const text = newItemText.trim()
    if (!text) return
    try {
      const response = await apiFetch('/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...getPeriodParams(), text, projectScope: 'work' }),
      })
      if (!response.ok) throw new Error('Failed to add item' + traceSuffix(response))
      setNewItemText('')
      // Refetch so the auto-ensured period row and ordering stay consistent.
      await fetchPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item')
    }
  }

  const handleAddWeekItem = async () => {
    const text = newWeekItemText.trim()
    if (!text || !targetWeek) return
    try {
      // The week plan is auto-ensured by the existing creation endpoint; the
      // item arrives unparented, so it enters the tree via the attach picker.
      const response = await apiFetch('/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'week',
          weekStart: targetWeek.start,
          weekEnd: targetWeek.end,
          text,
          projectScope: 'work',
        }),
      })
      if (!response.ok) throw new Error('Failed to add week item' + traceSuffix(response))
      setNewWeekItemText('')
      await fetchPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add week item')
    }
  }

  const handleUpdateItem = async (id: number, updates: Partial<PeriodPlanItem>) => {
    try {
      const response = await apiFetch(`/api/plan-items/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error('Failed to update item' + traceSuffix(response))
      const updated: PeriodPlanItem = await response.json()
      // Structural edits on a week item (attach, detach, re-parent) reshape the
      // tree and the attach-candidate list, so refetch the month payload.
      if (updates.parentItemId !== undefined) {
        await fetchPlan()
        return
      }
      // PUT returns the bare item row. Update either the month-level item or an
      // attached week item in place, carrying listing-only fields over so the
      // badges, children and week attribution stay visible after an inline edit.
      setItems((prev) => prev.map((item) => {
        if (item.id === id) {
          return {
            ...updated,
            fulfillmentCount: item.fulfillmentCount,
            commentCount: item.commentCount,
            directFulfillmentCount: item.directFulfillmentCount,
            indirectFulfillmentCount: item.indirectFulfillmentCount,
            childItems: item.childItems,
            inheritedChildGroups: item.inheritedChildGroups,
          }
        }
        if (item.childItems?.some((child) => child.id === id)) {
          return {
            ...item,
            childItems: item.childItems.map((child) =>
              child.id === id ? mergeChildRow(child, updated) : child
            ),
          }
        }
        return item
      }))
      // Priority drives the server-side grouping order, so refetch to let a
      // changed item move to its new group. Other edits keep their place.
      if (updates.priority !== undefined) {
        await fetchPlan()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item')
    }
  }

  // Attaching is an ordinary parent-link update on the week item; the existing
  // update endpoint is the only write surface.
  const handleAttachItem = (childId: number, parentItemId: number) => {
    void handleUpdateItem(childId, { parentItemId })
  }

  // Comment writes happen inside rows, outside the item endpoints this
  // component manages. Write the fresh count back into the listing payload so
  // a week child row that remounts (its group collapses) does not fall back to
  // a stale composed badge.
  const handleCommentCountChange = useCallback((id: number, count: number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id === id) return { ...item, commentCount: count }
        if (item.childItems?.some((child) => child.id === id)) {
          return {
            ...item,
            childItems: item.childItems.map((child) =>
              child.id === id ? { ...child, commentCount: count } : child
            ),
          }
        }
        return item
      })
    )
  }, [])

  const handleDeleteItem = async (id: number) => {
    try {
      const response = await apiFetch(`/api/plan-items/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Failed to delete item' + traceSuffix(response))
      // DELETE returns 200 JSON {deleted: true} (no longer 204). Referrer
      // warnings are surfaced pre-deletion via the confirm dialog's GET.
      const data: { deleted?: boolean } = await response.json()
      if (data.deleted === false) throw new Error('Failed to delete item' + traceSuffix(response))
      // A deleted month item disappears; a deleted attached week item is
      // removed from its parent's child list.
      setItems((prev) =>
        prev
          .filter((item) => item.id !== id)
          .map((item) =>
            item.childItems
              ? { ...item, childItems: item.childItems.filter((child) => child.id !== id) }
              : item
          )
      )
      setSelectedItemId((current) => (current === id ? null : current))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item')
    }
  }

  const handleDeferItem = async (id: number) => {
    try {
      const response = await apiFetch(`/api/plan-items/${id}/defer`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to defer item' + traceSuffix(response))
      await fetchPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to defer item')
    }
  }

  // Swap positions with the adjacent item in the same priority group. Moving a
  // group head up or a group tail down is a no-op, and the priority is never
  // part of the payload: ordering and priority stay orthogonal.
  const handleMoveItem = async (id: number, direction: 'up' | 'down') => {
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return
    const swapIndex = sameGroupNeighbour(items, index, direction)
    if (swapIndex === null) return
    const current = items[index]
    const neighbour = items[swapIndex]
    await Promise.all([
      apiFetch(`/api/plan-items/${current.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: neighbour.position }),
      }),
      apiFetch(`/api/plan-items/${neighbour.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: current.position }),
      }),
    ])
    await fetchPlan()
  }

  const handlePrevPeriod = () => {
    setCurrentDate((date) => (scope === 'week' ? subWeeks(date, 1) : subMonths(date, 1)))
  }

  const handleNextPeriod = () => {
    setCurrentDate((date) => (scope === 'week' ? addWeeks(date, 1) : addMonths(date, 1)))
  }

  // Keep the two-scope tab list keyboard operable, as the previous Tabs
  // component was: arrow keys switch scope and move focus.
  const handleScopeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next: PeriodPlanScope = scope === 'week' ? 'month' : 'week'
    setScope(next)
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)
      ?.focus()
  }

  const completedCount = items.filter((item) => item.status === 'done').length
  const totalCount = items.length
  const openCount = items.filter(
    (item) => item.status === 'planned' || item.status === 'in_progress'
  ).length
  const fulfillmentTotal = items.reduce(
    (total, item) => total + (item.fulfillmentCount ?? 0),
    0
  )
  const commentTotal = items.reduce((total, item) => total + (item.commentCount ?? 0), 0)
  const workCount = items.filter((item) => item.projectScope === 'work').length
  const personalCount = items.filter((item) => item.projectScope === 'personal').length

  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(
      PLAN_ITEM_STATUS_ORDER.map((status) => [status, 0])
    ) as Record<(typeof PLAN_ITEM_STATUS_ORDER)[number], number>
    for (const item of items) counts[item.status] += 1
    return counts
  }, [items])

  // Resolve the visible selection; a deleted or refetched-away selection falls
  // back to the deep-linked item, then the first row.
  const selectedItem = useMemo(() => {
    if (selectedItemId !== null) {
      const requested = findPlanItem(items, selectedItemId)
      if (requested) return requested
    }
    if (initialItemId !== null) {
      const deepLinked = findPlanItem(items, initialItemId)
      if (deepLinked) return deepLinked
    }
    return items[0] ?? null
  }, [items, selectedItemId, initialItemId])

  const selectedParentText = selectedItem?.parentItemId
    ? items.find((item) => item.id === selectedItem.parentItemId)?.text ?? null
    : null

  const getPeriodDisplay = () => {
    if (scope === 'week') {
      const range = getWeekPeriodRange(currentDate)
      return `${range.start} - ${range.end}`
    }
    return getMonthPeriodRange(currentDate).monthKey
  }

  const periodDisplay = getPeriodDisplay()
  const followThroughReady = totalCount > 0 && completedCount === totalCount

  return (
    <div className={styles.surface}>
      <div className={styles.split}>
        <section className={styles.primary} aria-label="Plan workspace">
          <header className={styles.pageHeading}>
            <div>
              <h1>Plan items</h1>
              <p className={styles.description}>
                One working list, one persistent inspector. Execution state,
                fulfillment evidence, and planning context stay distinct.
              </p>
            </div>
            <div className={styles.periodControls}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={handlePrevPeriod}
                aria-label="Previous period"
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <div className={styles.periodStamp}>
                <span>{scope === 'week' ? 'Week' : 'Month'}</span>
                <strong>{periodDisplay}</strong>
              </div>
              <button
                type="button"
                className={styles.iconButton}
                onClick={handleNextPeriod}
                aria-label="Next period"
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className={styles.periodBar}>
            <div
              className={styles.scopeTabs}
              role="tablist"
              aria-label="Plan scope"
              onKeyDown={handleScopeKeyDown}
            >
              <button
                type="button"
                role="tab"
                data-scope="week"
                tabIndex={scope === 'week' ? 0 : -1}
                aria-selected={scope === 'week'}
                className={styles.scopeTab}
                onClick={() => setScope('week')}
              >
                Week
              </button>
              <button
                type="button"
                role="tab"
                data-scope="month"
                tabIndex={scope === 'month' ? 0 : -1}
                aria-selected={scope === 'month'}
                className={styles.scopeTab}
                onClick={() => setScope('month')}
              >
                Month
              </button>
            </div>
            {totalCount > 0 && (
              <span className={styles.progressText}>
                {completedCount} of {totalCount} completed
              </span>
            )}
          </div>

          <section className={`${styles.panel} ${styles.composer}`} aria-label="Plan composition">
            <div className={styles.sectionHeading}>
              <div>
                <h2>Plan composition</h2>
                <p>
                  Add to the {scope === 'week' ? 'weekly' : 'monthly'} plan. Priority
                  groups and manual order organize the list.
                </p>
              </div>
              <Plus size={18} aria-hidden="true" />
            </div>
            <div className={styles.composerRow}>
              <input
                className={styles.textInput}
                value={newItemText}
                onChange={(event) => setNewItemText(event.target.value)}
                placeholder="Add a new plan item..."
                aria-label="New plan item"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleAddItem()
                }}
              />
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void handleAddItem()}
                disabled={!newItemText.trim()}
              >
                <Plus size={15} aria-hidden="true" />
                Add
              </button>
            </div>
          </section>

          {loading ? (
            <div role="status" className={styles.loadingState}>
              <span className={styles.loadingLine} />
              <strong>Loading plan items…</strong>
            </div>
          ) : error ? (
            <div role="alert" className={styles.errorState}>
              {error}
            </div>
          ) : items.length === 0 ? (
            <div className={styles.emptyState}>
              <CalendarDays size={24} aria-hidden="true" />
              <strong>No plans yet</strong>
              <span>
                Add your first {scope === 'week' ? 'weekly' : 'monthly'} plan item above.
              </span>
            </div>
          ) : (
            <div className={styles.list}>
              <div className={styles.listHeader} aria-hidden="true">
                <span>Item</span>
                <span>Evidence / status</span>
              </div>
              {items.map((item, index) => (
                <PeriodPlanItemRow
                  key={item.id}
                  item={item}
                  ordinal={index + 1}
                  selectedItemId={selectedItem?.id ?? null}
                  onSelect={setSelectedItemId}
                  autoExpandComments={item.id === initialItemId}
                  parentOptions={scope === 'week' ? parentOptions : []}
                  showParentSelector={scope === 'week'}
                  attachCandidates={scope === 'month' ? attachCandidates : []}
                  onAttach={scope === 'month' ? handleAttachItem : undefined}
                  childParentOptions={scope === 'month' ? items : []}
                  canMoveUp={sameGroupNeighbour(items, index, 'up') !== null}
                  canMoveDown={sameGroupNeighbour(items, index, 'down') !== null}
                  onUpdate={handleUpdateItem}
                  onDelete={handleDeleteItem}
                  onDefer={handleDeferItem}
                  onMove={handleMoveItem}
                  onCommentCountChange={handleCommentCountChange}
                />
              ))}
            </div>
          )}

          {scope === 'month' && weekOptions.length > 0 && (
            <section className={`${styles.panel} ${styles.weekComposer}`} aria-label="Add a week item">
              <div className={styles.sectionHeading}>
                <div>
                  <h2>Add a week item</h2>
                  <p>
                    Pick one of this month&apos;s weeks; the item lands in that week&apos;s plan.
                  </p>
                </div>
              </div>
              <div className={styles.weekComposerRow}>
                <select
                  aria-label="Target week"
                  value={targetWeek?.start ?? ''}
                  onChange={(event) => setTargetWeekStart(event.target.value)}
                  className={styles.selectField}
                >
                  {weekOptions.map((week) => (
                    <option key={week.start} value={week.start}>
                      Week {week.start} - {week.end}
                    </option>
                  ))}
                </select>
                <input
                  className={styles.textInput}
                  aria-label="New week item text"
                  value={newWeekItemText}
                  onChange={(event) => setNewWeekItemText(event.target.value)}
                  placeholder="Add a week item..."
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleAddWeekItem()
                  }}
                />
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void handleAddWeekItem()}
                  disabled={!newWeekItemText.trim() || !targetWeek}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add week item
                </button>
              </div>
            </section>
          )}
        </section>

        <aside className={styles.context} aria-label="Plan inspector">
          <PlanContextPanel
            item={selectedItem}
            periodLabel={periodDisplay}
            scope={scope}
            parentText={selectedParentText}
          />

          <section className={styles.summaryPanel} aria-label="Plan period summary">
            <div className={styles.sectionHeading}>
              <div>
                <h2>Period readiness</h2>
                <p>
                  Follow-through, evidence, and planning context for this {scope}.
                </p>
              </div>
              <Activity size={18} aria-hidden="true" />
            </div>

            <div className={styles.summaryCells}>
              <div
                className={styles.summaryCell}
                data-state={totalCount === 0 ? 'idle' : followThroughReady ? 'ready' : 'pending'}
              >
                <span>Follow-through</span>
                <strong>{completedCount}/{totalCount} done</strong>
                <small>Current {scope}</small>
              </div>
              <div
                className={styles.summaryCell}
                data-state={totalCount > 0 && openCount === 0 ? 'ready' : openCount > 0 ? 'pending' : 'idle'}
              >
                <span>Open items</span>
                <strong>{openCount} open</strong>
                <small>Planned + in progress</small>
              </div>
              <div
                className={styles.summaryCell}
                data-state={fulfillmentTotal > 0 ? 'ready' : 'idle'}
              >
                <span>Evidence</span>
                <strong>{fulfillmentTotal} linked</strong>
                <small>Fulfilling events</small>
              </div>
              <div className={styles.summaryCell} data-state="idle">
                <span>Planning context</span>
                <strong>{commentTotal} notes</strong>
                <small>Plan-item comments</small>
              </div>
            </div>

            <div className={styles.statusBreakdown} role="group" aria-label="Status breakdown">
              {PLAN_ITEM_STATUS_ORDER.map((status) => (
                <div className={styles.statusBreakdownRow} key={status}>
                  <span>
                    <i className={styles.statusDot} data-status={status} aria-hidden="true" />
                    {PLAN_ITEM_STATUS_LABELS[status]}
                  </span>
                  <strong>{statusCounts[status]}</strong>
                </div>
              ))}
            </div>

            <div className={styles.scopeSplit}>
              <span>Work {workCount}</span>
              <span>Personal {personalCount}</span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
