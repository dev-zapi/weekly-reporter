'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  X,
  ChevronDown,
  ChevronUp,
  Trash2,
  Loader2,
} from 'lucide-react'
import type { SyncResult } from '@/lib/collect/sync'
import { toast } from 'sonner'
import styles from './collection-sources.module.css'

interface SyncResultsCardProps {
  results: SyncResult[]
  onClose: () => void
  onSourceChanged?: () => void
}

export function SyncResultsCard({ results, onClose, onSourceChanged }: SyncResultsCardProps) {
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set())
  const [deletingBranches, setDeletingBranches] = useState<Set<string>>(new Set())
  const [localResults, setLocalResults] = useState<SyncResult[]>(results)

  const successCount = localResults.filter(result => result.status === 'success').length
  const failedCount = localResults.filter(result => result.status === 'failed').length

  const toggleError = (sourceId: number) => {
    setExpandedErrors(previous => {
      const next = new Set(previous)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }

  const handleDeleteBranch = async (sourceId: number, branchName: string) => {
    if (!confirm(`Remove branch ${branchName} from this source?`)) return

    const key = `${sourceId}-${branchName}`
    setDeletingBranches(previous => new Set(previous).add(key))

    try {
      const res = await apiFetch(`/api/collect/sources/${sourceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeBranch: branchName }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error((data.error || 'Failed to remove branch') + traceSuffix(res))
      }

      setLocalResults(previous =>
        previous.map(result => {
          if (result.sourceId !== sourceId || !result.branches) return result
          return {
            ...result,
            branches: result.branches.filter(branch => branch.name !== branchName),
          }
        }),
      )

      onSourceChanged?.()
      toast.success(`Branch ${branchName} removed`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove branch')
    } finally {
      setDeletingBranches(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  return (
    <section className={styles.syncResults} aria-labelledby="sync-results-heading">
      <div className={styles.syncHeader}>
        <div className={styles.syncTitle}>
          <h2 id="sync-results-heading">Sync results</h2>
          <div className={styles.syncSummary} aria-label={`${successCount} succeeded, ${failedCount} failed`}>
            <span className={styles.statusCount} data-tone="success">{successCount} succeeded</span>
            <span className={styles.statusCount} data-tone={failedCount > 0 ? 'failed' : 'neutral'}>{failedCount} failed</span>
          </div>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close sync results" title="Close sync results">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.resultList}>
        {localResults.map(result => (
          <SyncResultRow
            key={result.sourceId}
            result={result}
            expanded={expandedErrors.has(result.sourceId)}
            onToggle={() => toggleError(result.sourceId)}
            deletingBranches={deletingBranches}
            onDeleteBranch={handleDeleteBranch}
          />
        ))}
      </div>
    </section>
  )
}

interface SyncResultRowProps {
  result: SyncResult
  expanded: boolean
  onToggle: () => void
  deletingBranches: Set<string>
  onDeleteBranch: (sourceId: number, branchName: string) => void
}

function SyncResultRow({ result, expanded, onToggle, deletingBranches, onDeleteBranch }: SyncResultRowProps) {
  const { status, sourceName, commitsCount, eventsCount, error, warnings, branches } = result
  const title = (
    <div className={styles.resultTitle}>
      <span className={styles.sourceId}>#{result.sourceId}</span>
      <span>{sourceName}</span>
    </div>
  )

  if (status === 'failed') {
    const isLongError = Boolean(error && error.length > 100)
    const errorId = `sync-error-${result.sourceId}`
    return (
      <div className={styles.resultRow} data-status="failed">
        <XCircle size={18} className={styles.resultIcon} aria-hidden="true" />
        <div className={styles.resultBody}>
          {title}
          {error && (
            <div>
              <div id={errorId} className={`${styles.resultCopy} ${!expanded && isLongError ? styles.errorClamped : ''}`} role="alert">
                {error}
              </div>
              {isLongError && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={onToggle}
                  aria-expanded={expanded}
                  aria-controls={errorId}
                >
                  {expanded ? 'Collapse' : 'Expand'}
                  {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const hasFailedBranches = branches && branches.some(branch => branch.status === 'failed')
  const isMultiBranch = branches && branches.length > 1 && branches.some(branch => branch.name)

  if (hasFailedBranches && isMultiBranch) {
    return (
      <div className={styles.resultRow} data-status="warning">
        <AlertTriangle size={18} className={styles.resultIcon} aria-hidden="true" />
        <div className={styles.resultBody}>
          {title}
          <p className={styles.resultCopy}>Sync succeeded, but some branches failed</p>
          <div className={styles.branchList}>
            {branches.map(branch => {
              const branchKey = `${result.sourceId}-${branch.name}`
              const isDeleting = deletingBranches.has(branchKey)
              return (
                <div key={branch.name} className={styles.branchResult} data-status={branch.status}>
                  {branch.status === 'success' ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
                  <div>
                    <strong>{branch.name}</strong>{' '}
                    {branch.status === 'success' ? <span>{branch.commitsCount} commits</span> : <span>{branch.error}</span>}
                  </div>
                  {branch.status === 'failed' && (
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => onDeleteBranch(result.sourceId, branch.name)}
                      disabled={isDeleting}
                      title={`Remove branch ${branch.name}`}
                      aria-label={`Remove branch ${branch.name}`}
                    >
                      {isDeleting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <p className={styles.resultCounts}>commits: {commitsCount}, events: {eventsCount}</p>
        </div>
      </div>
    )
  }

  if (warnings && warnings.length > 0) {
    return (
      <div className={styles.resultRow} data-status="warning">
        <AlertTriangle size={18} className={styles.resultIcon} aria-hidden="true" />
        <div className={styles.resultBody}>
          {title}
          <p className={styles.resultCopy}>Sync succeeded, but some paths failed</p>
          <ul className={styles.warningList}>
            {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
          <p className={styles.resultCounts}>commits: {commitsCount}, events: {eventsCount}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.resultRow} data-status="success">
      <CheckCircle2 size={18} className={styles.resultIcon} aria-hidden="true" />
      <div className={styles.resultBody}>{title}</div>
      <div className={styles.resultCounts}>commits: {commitsCount}, events: {eventsCount}</div>
    </div>
  )
}
