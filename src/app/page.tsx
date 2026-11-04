'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { Calendar, Loader2, X } from 'lucide-react'
import { QuickInputBar } from '@/components/QuickInputBar'
import { TimelineView } from '@/components/TimelineView'
import { TimelineEvidenceTrace } from '@/components/TimelineEvidenceTrace'
import { TimelineReadiness } from '@/components/TimelineReadiness'
import { SourceFilterPanel, type SourceFilter } from '@/components/SourceFilterPanel'
import { TagFilterPanel } from '@/components/TagFilterPanel'
import { ActivityHeatmap, type HeatmapData } from '@/components/ActivityHeatmap'
import type { RawEvent, PeriodPlanScope } from '@/lib/db/schema'
import type { TimelineEvent } from '@/lib/event-view'
import { useSyncAllSources } from '@/components/SyncAllSources'
import { TimelinePlanPanel } from '@/components/TimelinePlanPanel'
import { ReferencePreviewDialog } from '@/components/ReferencePreviewDialog'
import { PlanItemPreviewDialog } from '@/components/PlanItemPreviewDialog'
import { HIGHLIGHT_DURATION_MS } from '@/lib/reference-constants'
import { buildPlansDeepLink } from '@/lib/plan-links'
import styles from '@/components/timeline.module.css'

const EVENTS_PAGE_LIMIT = 30
const REFERENCE_LOAD_MAX_PAGES = 5
const WIDE_LAYOUT_QUERY = '(min-width: 781px)'

/**
 * Auto-paging belongs to the two-column layout. Below 780px the split turns
 * into one column and the context aside follows the sentinel, so each appended
 * page would push Evidence trace, readiness, plans, and filters farther away.
 */
function subscribeToWideLayout(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const query = window.matchMedia(WIDE_LAYOUT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function getWideLayoutSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true
  }
  return window.matchMedia(WIDE_LAYOUT_QUERY).matches
}

function getServerWideLayoutSnapshot(): boolean {
  // The client snapshot takes over after hydration; paging markup is identical.
  return false
}

interface EventsPage {
  events: TimelineEvent[]
  nextCursor: { id: number; eventTime: number } | null
  hasMore: boolean
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export default function TimelinePage() {
  const router = useRouter()
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [heatmapData, setHeatmapData] = useState<HeatmapData[]>([])
  const [heatmapError, setHeatmapError] = useState<string | null>(null)
  const [selectedHeatmapDate, setSelectedHeatmapDate] = useState<string | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [selectedSources, setSelectedSources] = useState<SourceFilter[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('selectedSources')
      return saved ? JSON.parse(saved) : []
    }
    return []
  })
  const [selectedTags, setSelectedTags] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('selectedTags')
      try { return saved ? JSON.parse(saved) : [] }
      catch { return [] }
    }
    return []
  })
  const [tagsVersion, setTagsVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [nextCursor, setNextCursor] = useState<{ id: number; eventTime: number } | null>(null)
  const autoPagingEnabled = useSyncExternalStore(
    subscribeToWideLayout,
    getWideLayoutSnapshot,
    getServerWideLayoutSnapshot,
  )
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { completionVersion } = useSyncAllSources()
  const [referencePreviewId, setReferencePreviewId] = useState<number | null>(null)
  const [planReferencePreviewId, setPlanReferencePreviewId] = useState<number | null>(null)
  const [highlightEventId, setHighlightEventId] = useState<number | null>(null)
  // Monotonic counter used as a key to re-trigger highlight animation.
  const [highlightKey, setHighlightKey] = useState<number>(0)
  // Suppress sentinel loadMore while reference pagination is appending pages.
  const referencePaginatingRef = useRef(false)

  const buildEventsPage = useCallback(async (
    cursor: { id: number; eventTime: number } | undefined,
    sources: SourceFilter[],
    tags: string[],
    heatmapDate: string | null,
  ): Promise<EventsPage> => {
    const params = new URLSearchParams()
    params.set('limit', String(EVENTS_PAGE_LIMIT))
    if (sources.length > 0 && sources.length < 2) {
      params.set('source', sources[0])
    }
    // Tag filtering is full-volume — drop the date param when tags are present.
    if (tags.length > 0) {
      params.set('tags', tags.join(','))
    } else if (heatmapDate) {
      params.set('date', heatmapDate)
    }
    if (cursor) {
      params.set('cursorId', String(cursor.id))
      params.set('cursorTime', String(cursor.eventTime))
    }

    const res = await apiFetch(`/api/events?${params}`)
    if (!res.ok) {
      let message = `Failed to load events (${res.status})`
      try {
        const errorBody = await res.json() as { error?: string }
        if (errorBody.error) message = errorBody.error
      } catch {
        // Keep the status-based message when the body is not JSON.
      }
      throw new Error(message + traceSuffix(res))
    }
    const data = await res.json()
    return {
      events: data.events || [],
      nextCursor: data.nextCursor || null,
      hasMore: data.hasMore ?? false,
    }
  }, [])

  const loadEvents = useCallback(async (cursor?: { id: number; eventTime: number }, append = false) => {
    try {
      const page = await buildEventsPage(cursor, selectedSources, selectedTags, selectedHeatmapDate)

      if (append) {
        setEvents(prev => [...prev, ...page.events])
      } else {
        setEvents(page.events)
      }
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
      setLoadError(null)
    } catch (error) {
      console.error('Failed to load events:', error)
      setLoadError(error instanceof Error ? error.message : 'Failed to load events')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [selectedSources, selectedTags, selectedHeatmapDate, buildEventsPage])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || nextCursor === null) return
    // Don't race with the reference pagination loop appending pages.
    if (referencePaginatingRef.current) return
    setLoadingMore(true)
    loadEvents(nextCursor, true)
  }, [loadingMore, hasMore, nextCursor, loadEvents])

  // 初始加载 / 筛选变化时重置
  useEffect(() => {
    setLoading(true)
    setEvents([])
    setNextCursor(null)
    setHasMore(true)
    loadEvents()
  }, [selectedSources, selectedTags, selectedHeatmapDate, completionVersion, loadEvents])

  // Keep the evidence trace anchored to a visible record. A selected record
  // that is filtered out falls back to the first loaded record instead of
  // leaving the inspector on a dangling ID.
  const activeEventId = selectedEventId !== null
    && events.some((event) => event.id === selectedEventId)
    ? selectedEventId
    : events[0]?.id ?? null

  // 滚动到底部自动加载更多
  useEffect(() => {
    if (!autoPagingEnabled) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadMore()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [autoPagingEnabled, hasMore, loadingMore, loadMore])

  // Load heatmap data (independent of timeline filters)
  useEffect(() => {
    const loadHeatmap = async () => {
      try {
        setHeatmapError(null)
        const res = await apiFetch('/api/events/heatmap')
        if (!res.ok) {
          throw new Error('Failed to load heatmap data' + traceSuffix(res))
        }
        const json = await res.json()
        setHeatmapData(json.data || [])
      } catch (error) {
        console.error('Failed to load heatmap data:', error)
        setHeatmapError('Activity data could not load.')
      }
    }
    loadHeatmap()
  }, [completionVersion])

  // 持久化筛选条件到 sessionStorage
  useEffect(() => {
    sessionStorage.setItem('selectedSources', JSON.stringify(selectedSources))
  }, [selectedSources])

  useEffect(() => {
    sessionStorage.setItem('selectedTags', JSON.stringify(selectedTags))
  }, [selectedTags])

  const scrollToEvent = useCallback((eventId: number) => {
    const element = document.querySelector(`[data-event-id="${eventId}"]`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setSelectedEventId(eventId)
      setHighlightEventId(eventId)
      setHighlightKey((k) => k + 1)
      setTimeout(() => setHighlightEventId(null), HIGHLIGHT_DURATION_MS)
    }
  }, [])

  // Wait for an event with the given id to appear in the DOM, then scroll + highlight.
  // Uses requestAnimationFrame polling with a timeout to avoid blind setTimeout races.
  // Falls back to onTimeout() if the element never appears within timeoutMs.
  const waitForAndScroll = useCallback((
    eventId: number,
    timeoutMs = 3000,
    onTimeout?: () => void,
  ) => {
    const start = performance.now()
    const tick = () => {
      const element = document.querySelector(`[data-event-id="${eventId}"]`)
      if (element) {
        scrollToEvent(eventId)
        return
      }
      if (performance.now() - start > timeoutMs) {
        onTimeout?.()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [scrollToEvent])

  const handleReferenceClick = useCallback(async (referenceId: number) => {
    // Check if already loaded
    const found = events.find((e) => e.id === referenceId)
    if (found) {
      scrollToEvent(referenceId)
      return
    }

    // Try to load more events until found (up to max pages)
    let currentCursor = nextCursor
    let lastPage: EventsPage | null = null
    let pagesLoaded = 0

    referencePaginatingRef.current = true
    try {
      while (currentCursor && pagesLoaded < REFERENCE_LOAD_MAX_PAGES) {
        const page = await buildEventsPage(currentCursor, selectedSources, selectedTags, selectedHeatmapDate)
        lastPage = page

        if (page.events.length > 0) {
          setEvents((prev) => [...prev, ...page.events])
          const foundInBatch = page.events.find((e) => e.id === referenceId)
          if (foundInBatch) {
            // Always update cursor state, then scroll once rendered.
            setNextCursor(page.nextCursor)
            setHasMore(page.hasMore)
            waitForAndScroll(referenceId)
            return
          }
        }

        currentCursor = page.nextCursor
        if (!page.hasMore) break
        pagesLoaded++
      }

      // Always persist the final cursor state so infinite scroll doesn't duplicate.
      if (lastPage) {
        setNextCursor(lastPage.nextCursor)
        setHasMore(lastPage.hasMore)
      }
    } finally {
      referencePaginatingRef.current = false
    }

    // Not found in loaded events or doesn't match filter - show popover
    setReferencePreviewId(referenceId)
  }, [events, nextCursor, selectedSources, selectedTags, selectedHeatmapDate, scrollToEvent, waitForAndScroll, buildEventsPage])

  const handleLocateEvent = useCallback(async (eventId: number) => {
    // Fetch the event to get its date
    const res = await apiFetch(`/api/events/${eventId}`)
    if (!res.ok) {
      setReferencePreviewId(null)
      return
    }
    const event = await res.json()
    // Use local calendar date (not UTC) to match /api/events date param interpretation.
    const dateStr = formatLocalDate(new Date(event.eventTime))

    // Clear filters and set date to make event visible
    setSelectedEventId(null)
    setSelectedSources([])
    setSelectedTags([])
    setSelectedHeatmapDate(dateStr)
    setReferencePreviewId(null)

    // Wait for the event to render (filter change triggers reload), then scroll.
    // On timeout, fall back to showing the preview dialog per spec branch c.
    waitForAndScroll(eventId, 5000, () => setReferencePreviewId(eventId))
  }, [waitForAndScroll])

  const handlePlanReferenceClick = useCallback((planItemId: number) => {
    // Plan items are not part of the timeline event list, so there is nothing to
    // locate in place — open the read-only preview directly.
    setPlanReferencePreviewId(planItemId)
  }, [])

  const handleGoToPlans = useCallback((scope: PeriodPlanScope, periodStart: string) => {
    setPlanReferencePreviewId(null)
    router.push(buildPlansDeepLink(scope, periodStart))
  }, [router])

  const handleSubmit = async ({ content }: { content: string }) => {
    await apiFetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    setSelectedEventId(null)
    loadEvents(undefined, false)
    setTagsVersion(v => v + 1)
  }

  const handleEdit = async (id: number, data: Partial<RawEvent>) => {
    await apiFetch(`/api/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    loadEvents(undefined, false)
    setTagsVersion(v => v + 1)
  }

  const handleDelete = async (id: number) => {
    await apiFetch(`/api/events/${id}`, { method: 'DELETE' })
    loadEvents(undefined, false)
  }

  const handleSourceSelect = (source: SourceFilter) => {
    setSelectedEventId(null)
    setSelectedSources(prev =>
      prev.includes(source)
        ? prev.filter(s => s !== source)
        : [...prev, source]
    )
  }

  const handleClearFilters = () => {
    setSelectedEventId(null)
    setSelectedSources([])
  }

  const handleTagSelect = (tag: string) => {
    setSelectedEventId(null)
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  const handleClearTags = () => {
    setSelectedEventId(null)
    setSelectedTags([])
  }

  const handleTagsChanged = () => {
    setTagsVersion(v => v + 1)
    loadEvents(undefined, false)
  }

  const handleHeatmapDateSelect = (date: string | null) => {
    setSelectedEventId(null)
    setSelectedHeatmapDate(date)
  }

  return (
    <div className={styles.page}>
      <div className={styles.split}>
        <section className={styles.primary} aria-labelledby="timeline-title">
          <header className={styles.pageHeading}>
            <div>
              <h1 id="timeline-title">Work evidence</h1>
              <p className={styles.pageDescription}>
                Capture work quickly, then trace how each record becomes reportable fact.
              </p>
            </div>
          </header>

          <QuickInputBar onSubmit={handleSubmit} />

          {loadError && (
            <div className={styles.errorState} role="alert">
              <strong>Could not load the timeline</strong>
              <p>{loadError}</p>
            </div>
          )}

          {loading ? (
            <div className={styles.loadingState} role="status">
              <span className={styles.loadingLine} />
              <strong>Loading your records…</strong>
            </div>
          ) : (
            <>
              <TimelineView
                events={events}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onReferenceClick={handleReferenceClick}
                onPlanReferenceClick={handlePlanReferenceClick}
                highlightEventId={highlightEventId}
                highlightKey={highlightKey}
                selectedEventId={activeEventId}
                onEventSelect={setSelectedEventId}
              />
              <div ref={sentinelRef} className={styles.sentinel}>
                {loadingMore ? (
                  <div className={styles.sentinelStatus} role="status">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading…
                  </div>
                ) : hasMore ? (
                  <button type="button" className={styles.secondaryButton} onClick={loadMore}>
                    Load more
                  </button>
                ) : events.length > 0 ? (
                  <span className={styles.sentinelStatus}>All loaded</span>
                ) : null}
              </div>
            </>
          )}
        </section>

        <aside className={styles.context} aria-label="Timeline context">
          <TimelineEvidenceTrace events={events} selectedEventId={activeEventId} />
          <TimelineReadiness eventsCount={events.length} refreshKey={completionVersion} />
          <ActivityHeatmap
            data={heatmapData}
            selectedDate={selectedHeatmapDate}
            onDateSelect={handleHeatmapDateSelect}
            error={heatmapError}
          />
          <TimelinePlanPanel refreshKey={completionVersion} />
          {selectedHeatmapDate && (
            <div className={styles.dateChip}>
              <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{selectedHeatmapDate}</span>
              <button
                type="button"
                onClick={() => setSelectedHeatmapDate(null)}
                aria-label="Clear selected date"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )}
          <SourceFilterPanel
            selectedSources={selectedSources}
            onSourceSelect={handleSourceSelect}
            onClearFilters={handleClearFilters}
          />
          <TagFilterPanel
            selectedTags={selectedTags}
            onTagSelect={handleTagSelect}
            onClearTags={handleClearTags}
            onTagsChanged={handleTagsChanged}
            tagsVersion={tagsVersion}
          />
        </aside>
      </div>

      <ReferencePreviewDialog
        eventId={referencePreviewId}
        onClose={() => setReferencePreviewId(null)}
        onLocate={handleLocateEvent}
      />

      <PlanItemPreviewDialog
        itemId={planReferencePreviewId}
        onClose={() => setPlanReferencePreviewId(null)}
        onGoToPlans={handleGoToPlans}
      />
    </div>
  )
}
