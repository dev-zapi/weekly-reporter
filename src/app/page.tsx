'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { QuickInputBar } from '@/components/QuickInputBar'
import { TimelineView } from '@/components/TimelineView'
import { SourceFilterPanel, type SourceFilter } from '@/components/SourceFilterPanel'
import { TagFilterPanel } from '@/components/TagFilterPanel'
import { ActivityHeatmap, type HeatmapData } from '@/components/ActivityHeatmap'
import { Button } from '@/components/ui/button'
import { Loader2, Calendar, X } from 'lucide-react'
import type { RawEvent } from '@/lib/db/schema'
import { useSyncAllSources } from '@/components/SyncAllSources'
import { TimelinePlanPanel } from '@/components/TimelinePlanPanel'
import { ReferencePreviewDialog } from '@/components/ReferencePreviewDialog'
import { HIGHLIGHT_DURATION_MS } from '@/lib/reference-constants'

const EVENTS_PAGE_LIMIT = 30
const REFERENCE_LOAD_MAX_PAGES = 5

interface EventsPage {
  events: RawEvent[]
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
  const [events, setEvents] = useState<RawEvent[]>([])
  const [heatmapData, setHeatmapData] = useState<HeatmapData[]>([])
  const [selectedHeatmapDate, setSelectedHeatmapDate] = useState<string | null>(null)
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [nextCursor, setNextCursor] = useState<{ id: number; eventTime: number } | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { completionVersion } = useSyncAllSources()
  const [referencePreviewId, setReferencePreviewId] = useState<number | null>(null)
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

    const res = await fetch(`/api/events?${params}`)
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
    } catch (error) {
      console.error('Failed to load events:', error)
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
  }, [selectedSources, selectedTags, selectedHeatmapDate, completionVersion])

  // 滚动到底部自动加载更多
  useEffect(() => {
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
  }, [hasMore, loadingMore, loadMore])

  // Load heatmap data (independent of timeline filters)
  useEffect(() => {
    const loadHeatmap = async () => {
      try {
        const res = await fetch('/api/events/heatmap')
        const json = await res.json()
        setHeatmapData(json.data || [])
      } catch (error) {
        console.error('Failed to load heatmap data:', error)
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
    const res = await fetch(`/api/events/${eventId}`)
    if (!res.ok) {
      setReferencePreviewId(null)
      return
    }
    const event = await res.json()
    // Use local calendar date (not UTC) to match /api/events date param interpretation.
    const dateStr = formatLocalDate(new Date(event.eventTime))

    // Clear filters and set date to make event visible
    setSelectedSources([])
    setSelectedTags([])
    setSelectedHeatmapDate(dateStr)
    setReferencePreviewId(null)

    // Wait for the event to render (filter change triggers reload), then scroll.
    // On timeout, fall back to showing the preview dialog per spec branch c.
    waitForAndScroll(eventId, 5000, () => setReferencePreviewId(eventId))
  }, [waitForAndScroll])

  const handleSubmit = async ({ content }: { content: string }) => {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    loadEvents(undefined, false)
    setTagsVersion(v => v + 1)
  }

  const handleEdit = async (id: number, data: Partial<RawEvent>) => {
    await fetch(`/api/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    loadEvents(undefined, false)
    setTagsVersion(v => v + 1)
  }

  const handleDelete = async (id: number) => {
    await fetch(`/api/events/${id}`, { method: 'DELETE' })
    loadEvents(undefined, false)
  }

  const handleSourceSelect = (source: SourceFilter) => {
    setSelectedSources(prev =>
      prev.includes(source)
        ? prev.filter(s => s !== source)
        : [...prev, source]
    )
  }

  const handleClearFilters = () => {
    setSelectedSources([])
  }

  const handleTagSelect = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  const handleClearTags = () => {
    setSelectedTags([])
  }

  const handleTagsChanged = () => {
    setTagsVersion(v => v + 1)
    loadEvents(undefined, false)
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-6">
        <QuickInputBar onSubmit={handleSubmit} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          {loading ? (
            <div className="text-center py-12">Loading...</div>
          ) : (
            <>
              <TimelineView
                events={events}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onReferenceClick={handleReferenceClick}
                highlightEventId={highlightEventId}
                highlightKey={highlightKey}
              />
              <div ref={sentinelRef} className="flex justify-center py-4">
                {loadingMore ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading…
                  </div>
                ) : hasMore ? (
                  <Button variant="ghost" size="sm" onClick={loadMore}>
                    Load more
                  </Button>
                ) : events.length > 0 ? (
                  <span className="text-xs text-muted-foreground">All loaded</span>
                ) : null}
              </div>
            </>
          )}
        </div>

        <div className="space-y-4">
          <ActivityHeatmap
            data={heatmapData}
            selectedDate={selectedHeatmapDate}
            onDateSelect={setSelectedHeatmapDate}
          />
          <TimelinePlanPanel refreshKey={completionVersion} />
          {selectedHeatmapDate && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted text-sm">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{selectedHeatmapDate}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 ml-auto"
                onClick={() => setSelectedHeatmapDate(null)}
              >
                <X className="h-3 w-3" />
              </Button>
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
        </div>
      </div>

      <ReferencePreviewDialog
        eventId={referencePreviewId}
        onClose={() => setReferencePreviewId(null)}
        onLocate={handleLocateEvent}
      />
    </div>
  )
}
