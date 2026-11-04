'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FileText, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import type { AudienceVariant } from '@/lib/db/schema'
import { ReportCard, type ReportSummary } from './ReportCard'
import { ReportPreviewPanel, type ReportDetail } from './ReportPreviewPanel'
import styles from './ReportsLibrary.module.css'

type ListState = 'loading' | 'ready' | 'error'

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; reportId: number }
  | { status: 'error'; reportId: number; message: string }
  | { status: 'ready'; reportId: number; detail: ReportDetail }

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json()
    if (data && typeof data.error === 'string' && data.error.trim()) {
      return `${data.error}${traceSuffix(response)}`
    }
  } catch {
    // The response carried no JSON body; fall back to the caller's message.
  }
  return `${fallback}${traceSuffix(response)}`
}

function nextSelection(current: number | null, next: ReportSummary[]): number | null {
  if (current !== null && next.some((report) => report.id === current)) return current
  return next[0]?.id ?? null
}

/**
 * Production report library: a numbered, searchable index in the primary
 * area and a live audience preview in the persistent right context.
 */
export function ReportList() {
  const [reports, setReports] = useState<ReportSummary[]>([])
  const [listState, setListState] = useState<ListState>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'idle' })
  const [previewToken, setPreviewToken] = useState(0)
  const [audience, setAudience] = useState<AudienceVariant>('leadership')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const listSequence = useRef(0)

  useEffect(() => {
    const sequence = ++listSequence.current
    let cancelled = false

    void (async () => {
      try {
        const response = await apiFetch('/api/reports')
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response, 'Failed to load reports'))
        }
        const data = await response.json()
        if (cancelled || sequence !== listSequence.current) return
        const next = (data.reports ?? []) as ReportSummary[]
        setReports(next)
        setSelectedId((current) => nextSelection(current, next))
        setListState('ready')
      } catch (error) {
        if (cancelled || sequence !== listSequence.current) return
        setListError(error instanceof Error ? error.message : 'Failed to load reports')
        setListState('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  useEffect(() => {
    if (selectedId === null) return

    let cancelled = false

    void (async () => {
      try {
        const response = await apiFetch(`/api/reports/${selectedId}`)
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response, 'Failed to load report preview'))
        }
        const data = await response.json()
        if (cancelled) return
        setPreviewState({
          status: 'ready',
          reportId: selectedId,
          detail: {
            ...(data as ReportSummary),
            variants: Array.isArray(data?.variants) ? data.variants : [],
          },
        })
      } catch (error) {
        if (!cancelled) {
          setPreviewState({
            status: 'error',
            reportId: selectedId,
            message: error instanceof Error ? error.message : 'Failed to load report preview',
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedId, previewToken])

  async function runSearch(rawQuery: string) {
    const sequence = ++listSequence.current
    const trimmed = rawQuery.trim()
    setSearching(true)
    setSearchError(null)

    try {
      const response = await apiFetch(
        trimmed ? `/api/reports/search?q=${encodeURIComponent(trimmed)}` : '/api/reports',
      )
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, 'Search failed'))
      }
      const data = await response.json()
      if (sequence !== listSequence.current) return
      const next = (data.reports ?? []) as ReportSummary[]
      setReports(next)
      setSelectedId((current) => nextSelection(current, next))
      setListState('ready')
      setListError(null)
    } catch (error) {
      if (sequence !== listSequence.current) return
      const message = error instanceof Error ? error.message : 'Search failed'
      setSearchError(message)
      toast.error(message)
    } finally {
      if (sequence === listSequence.current) setSearching(false)
    }
  }

  function handleSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
    const value = event.target.value
    setQuery(value)
    void runSearch(value)
  }

  function handleClearSearch() {
    setQuery('')
    void runSearch('')
  }

  async function handleDelete(id: number) {
    if (!window.confirm('Delete this report?')) return

    setDeletingId(id)
    try {
      const response = await apiFetch(`/api/reports/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, 'Delete failed'))
      }
      const next = reports.filter((report) => report.id !== id)
      setReports(next)
      if (selectedId === id) setSelectedId(next[0]?.id ?? null)
      toast.success('Report deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  function retryList() {
    setListState('loading')
    setListError(null)
    setReloadToken((token) => token + 1)
  }

  function retryPreview() {
    if (selectedId !== null) {
      setPreviewState({ status: 'loading', reportId: selectedId })
    }
    setPreviewToken((token) => token + 1)
  }

  const trimmedQuery = query.trim()
  const showEmptyLibrary = listState === 'ready' && reports.length === 0

  // Derive the preview from the currently selected report. A response for a
  // previous row is never displayed, and switching rows shows loading rather
  // than the previous report's final.
  let preview: ReportDetail | null = null
  let previewLoading = false
  let previewError: string | null = null
  if (selectedId !== null) {
    if (previewState.status === 'ready' && previewState.reportId === selectedId) {
      preview = previewState.detail
    } else if (previewState.status === 'error' && previewState.reportId === selectedId) {
      previewError = previewState.message
    } else {
      previewLoading = true
    }
  }

  return (
    <div className={styles.split}>
      <section className={styles.primary} aria-labelledby="report-library-title">
        <header className={styles.pageHeading}>
          <div>
            <h1 id="report-library-title">Report library</h1>
            <p>Search the numbered index, then preview an audience before opening full review.</p>
          </div>
          <Link href="/new" className={styles.primaryButton}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New report
          </Link>
        </header>

        <div className={styles.searchField}>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search reports"
            placeholder="Search reports by title or content"
            value={query}
            onChange={handleSearchChange}
          />
          {searching ? (
            <span className={styles.searching} role="status">
              Searching…
            </span>
          ) : query ? (
            <button
              type="button"
              className={styles.clearSearch}
              aria-label="Clear report search"
              onClick={handleClearSearch}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {searchError && (
          <div className={styles.errorState} role="alert">
            <strong>Search failed</strong>
            <p>{searchError}</p>
            <button type="button" className={styles.stateAction} onClick={() => void runSearch(query)}>
              Retry search
            </button>
          </div>
        )}

        {listState === 'loading' ? (
          <div className={styles.loadingState} role="status">
            <span className={styles.loadingLine} aria-hidden="true" />
            <strong>Loading reports…</strong>
          </div>
        ) : listState === 'error' ? (
          <div className={styles.errorState} role="alert">
            <strong>Reports could not load</strong>
            <p>{listError}</p>
            <button
              type="button"
              className={styles.stateAction}
              onClick={retryList}
            >
              Retry
            </button>
          </div>
        ) : showEmptyLibrary ? (
          trimmedQuery ? (
            <div className={styles.stateBox}>
              <Search size={22} aria-hidden="true" />
              <strong>No matching reports</strong>
              <p>No report title or content matches “{trimmedQuery}”. Try another term or clear the search.</p>
              <button type="button" className={styles.stateAction} onClick={handleClearSearch}>
                Clear search
              </button>
            </div>
          ) : (
            <div className={styles.stateBox}>
              <FileText size={22} aria-hidden="true" />
              <strong>No reports yet</strong>
              <p>Create a report from a week of evidence to start the library.</p>
              <Link href="/new" className={styles.primaryButton}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                New report
              </Link>
            </div>
          )
        ) : (
          <>
            <div className={styles.indexHeading}>
              <h2>{trimmedQuery ? 'Search results' : 'Recent reports'}</h2>
              <span aria-live="polite">
                {reports.length}{' '}
                {trimmedQuery
                  ? reports.length === 1 ? 'match' : 'matches'
                  : 'shown'}{' '}
                · latest first
              </span>
            </div>
            <div className={styles.reportRows} role="list" aria-label="Reports">
              {reports.map((report) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  audience={audience}
                  selected={selectedId === report.id}
                  deleting={deletingId === report.id}
                  onSelect={setSelectedId}
                  onDelete={(id) => void handleDelete(id)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <aside className={styles.context} aria-label="Selected report preview">
        <ReportPreviewPanel
          report={preview}
          audience={audience}
          onAudienceChange={setAudience}
          loading={previewLoading}
          error={previewError}
          onRetry={retryPreview}
        />
      </aside>
    </div>
  )
}
