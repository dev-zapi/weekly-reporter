'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { RefreshCw, RotateCcw, Download, Trash2, Edit, ChevronLeft, ChevronRight, Search, X, Loader2, CheckCircle2, XCircle, Clock, ToggleLeft, ToggleRight, AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown, Briefcase, User } from 'lucide-react'
import { toast } from 'sonner'
import { formatSystemDate, formatSystemDateTime, formatSystemRelativeTime } from '@/lib/time-format'
import {
  syncSource,
  fetchRepo,
  toggleSource,
  deleteSource,
  bulkUpdateScope,
  bulkDelete,
} from '@/lib/collect/source-commands'
import { useSourceListQuery } from './collect/useSourceListQuery'
import { isSyncFailure } from '@/lib/collect/sync-status'
import styles from './collection-sources.module.css'

export interface CollectSource {
  id: number
  type: string
  name: string
  projectScope: 'work' | 'personal'
  config: {
    baseUrl?: string
    owner: string
    repo: string
    token: string
    authorEmails: string[]
    branches?: Array<string | { name: string; lastCommitTime?: string | null }>
    branchCursors?: Array<{ name: string; lastCommitTime: string | null }>
    aliases?: string[]
  }
  enabled: boolean
  status: 'enabled' | 'disabled' | 'unavailable' | null
  lastSyncAt: string | null
  lastSyncStatus: string | null
  createdAt: string
  updatedAt: string
}

type SortableColumn = 'name' | 'type' | 'projectScope' | 'lastSyncAt' | 'status'

interface FilterOption {
  value: string
  label: string
}

function FilterGroup({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string
  name: string
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
}) {
  return (
    <fieldset className={styles.filterGroup}>
      <legend>{label}</legend>
      <div className={styles.filterOptions}>
        {options.map(option => (
          <label key={option.value} className={styles.filterOption}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={event => onChange(event.target.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function SortHeader({
  column,
  label,
  sortBy,
  sortOrder,
  onSort,
}: {
  column: SortableColumn
  label: string
  sortBy: string
  sortOrder: string
  onSort: (column: string) => void
}) {
  const direction = sortBy === column ? sortOrder : null
  const icon = sortBy !== column
    ? <ArrowUpDown size={12} aria-hidden="true" />
    : sortOrder === 'asc'
      ? <ArrowUp size={12} aria-hidden="true" />
      : <ArrowDown size={12} aria-hidden="true" />

  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className={styles.sortButton}
      aria-label={`Sort by ${label}${direction ? `, currently ${direction}ending` : ''}`}
    >
      {label}
      {icon}
    </button>
  )
}

function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 30 * 24 * 60 * 60 * 1000) return formatSystemRelativeTime(dateStr)
  return formatSystemDate(dateStr)
}

export function CollectSourceList({ onRefresh }: { onRefresh?: (fetchFn: () => void) => void }) {
  const {
    sources, setSources, total, loading, error, page, setPage, filters, refetch,
  } = useSourceListQuery()
  const {
    searchInput, searchTerm, syncStatusFilter, sourceStatusFilter,
    typeFilter, scopeFilter, sortBy, sortOrder,
    setSearchInput, setSearchTerm, setSyncStatusFilter, setSourceStatusFilter,
    setTypeFilter, setScopeFilter, setSort,
  } = filters

  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set())
  const [fetchingIds, setFetchingIds] = useState<Set<number>>(new Set())
  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const pageSize = 20

  useEffect(() => {
    if (onRefresh) {
      onRefresh(() => {
        setPage(1)
        refetch(1)
      })
    }
  }, [onRefresh, setPage, refetch])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasFilters = Boolean(searchTerm || typeFilter || syncStatusFilter || sourceStatusFilter || scopeFilter)

  function getSourceTypeLabel(type: string): string {
    switch (type) {
      case 'git-remote-github':
        return 'GitHub'
      case 'git-remote-gitlab':
        return 'GitLab'
      case 'git-remote-gitee':
        return 'Gitee'
      case 'git-local':
        return 'Local'
      default:
        return type
    }
  }

  function getBranchNames(config: CollectSource['config']): string[] {
    return config.branches?.map(b => typeof b === 'string' ? b : b.name).filter(Boolean) || []
  }

  function getSyncCursor(config: CollectSource['config']): string | null {
    // `branches` only carries cursors for explicitly configured branches; the
    // all-branches (and remote default) mode advances `branchCursors`. Prefer
    // whichever has the latest committer time so the column reflects the real
    // collection cursor instead of showing "–" for default-branch sources.
    const branchMax = config.branches?.reduce((max, b) => {
      if (typeof b === 'object' && b.lastCommitTime) {
        const t = new Date(b.lastCommitTime).getTime()
        return t > max ? t : max
      }
      return max
    }, 0) ?? 0
    const cursorMax = config.branchCursors?.reduce((max, c) => {
      if (!c.lastCommitTime) return max
      const t = new Date(c.lastCommitTime).getTime()
      return t > max ? t : max
    }, 0) ?? 0
    const maxCursor = Math.max(branchMax, cursorMax)
    if (maxCursor) {
      return formatSystemDateTime(maxCursor)
    }
    return null
  }

  function truncateList(items: string[], max = 1): { text: string; full: string } {
    if (items.length === 0) return { text: '-', full: '' }
    if (items.length <= max) return { text: items.join(', '), full: items.join(', ') }
    return { text: `${items[0]} +${items.length - 1}`, full: items.join(', ') }
  }

  async function runSync(sourceId: number, opts?: { resync?: boolean }) {
    if (opts?.resync && !confirm('Resync will fetch all historical commits without duplicating existing records. Continue?')) return
    setSyncingIds(prev => new Set(prev).add(sourceId))
    try {
      const result = await syncSource(sourceId, opts)
      if (result.ok) {
        toast.success(
          opts?.resync
            ? `Resync complete. Added ${result.eventsCount} events`
            : `${result.eventsCount} events synced`,
        )
        if (result.warnings?.length) {
          toast.warning(result.warnings.join('\n'))
        }
      } else if (result.autoDisabled) {
        toast.error('Path not found; source marked unavailable')
      } else {
        toast.error(result.error || (opts?.resync ? 'Resync failed' : 'Sync failed'))
      }

      refetch()
    } catch {
      toast.error(opts?.resync ? 'Resync failed' : 'Sync failed')
    } finally {
      setSyncingIds(prev => { const next = new Set(prev); next.delete(sourceId); return next })
    }
  }

  async function handleFetch(sourceId: number) {
    setFetchingIds(prev => new Set(prev).add(sourceId))
    try {
      const result = await fetchRepo(sourceId)
      if (result.ok) {
        toast.success('Repository fetch complete')
      } else {
        toast.error(result.error || 'Repository fetch failed')
      }
    } catch {
      toast.error('Repository fetch failed')
    } finally {
      setFetchingIds(prev => { const next = new Set(prev); next.delete(sourceId); return next })
    }
  }

  async function handleToggle(sourceId: number, currentStatus: string) {
    if (currentStatus === 'unavailable') return
    const newStatus = currentStatus === 'enabled' ? 'disabled' : 'enabled'
    setTogglingIds(prev => new Set(prev).add(sourceId))
    setSources(prev => prev.map(source => source.id === sourceId ? { ...source, status: newStatus, enabled: newStatus === 'enabled' } : source))
    try {
      const result = await toggleSource(sourceId, newStatus)
      if (!result.ok) {
        setSources(prev => prev.map(source => source.id === sourceId ? { ...source, status: currentStatus as CollectSource['status'], enabled: currentStatus === 'enabled' } : source))
        toast.error(result.error || 'Failed to update status')
      }
    } catch {
      setSources(prev => prev.map(source => source.id === sourceId ? { ...source, status: currentStatus as CollectSource['status'], enabled: currentStatus === 'enabled' } : source))
      toast.error('Failed to update status')
    } finally {
      setTogglingIds(prev => { const next = new Set(prev); next.delete(sourceId); return next })
    }
  }

  async function handleDelete(sourceId: number) {
    if (!confirm('Delete this source?')) return

    try {
      const result = await deleteSource(sourceId)
      if (result.ok) {
        toast.success('Deleted successfully')
        if (sources.length === 1 && page > 1) {
          setPage(page - 1)
        } else {
          refetch()
        }
      } else {
        toast.error(result.error || 'Delete failed')
      }
    } catch {
      toast.error('Delete failed')
    }
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === sources.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sources.map(source => source.id)))
    }
  }

  async function handleBulkUpdateScope(newScope: 'work' | 'personal') {
    if (selectedIds.size === 0) return

    try {
      setBulkUpdating(true)
      const result = await bulkUpdateScope(Array.from(selectedIds), newScope)
      if (result.ok) {
        toast.success(`Updated project scope for ${result.updatedCount} sources`)
        setSelectedIds(new Set())
        refetch()
      } else {
        toast.error(result.error || 'Update failed')
      }
    } catch {
      toast.error('Update failed')
    } finally {
      setBulkUpdating(false)
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`Delete the ${selectedIds.size} selected sources?`)) return

    try {
      setBulkUpdating(true)
      const result = await bulkDelete(Array.from(selectedIds))
      if (result.ok) {
        toast.success(`Deleted ${result.deletedCount} sources`)
        if (selectedIds.size >= sources.length && page > 1) {
          setSelectedIds(new Set())
          setPage(page - 1)
        } else {
          setSelectedIds(new Set())
          refetch()
        }
      } else {
        toast.error(result.error || 'Delete failed')
      }
    } catch {
      toast.error('Delete failed')
    } finally {
      setBulkUpdating(false)
    }
  }

  return (
    <section aria-labelledby="source-index-heading">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="source-index-heading">Source index</h2>
          <p>Stable source references, collection readiness, and repository operations.</p>
        </div>
        <span className={styles.resultMeta} role="status" aria-live="polite">
          {loading && sources.length > 0 ? 'Refreshing sources…' : `${total} ${total === 1 ? 'source' : 'sources'}`}
        </span>
      </div>

      {loading && sources.length === 0 ? (
        <div className={styles.loadingState} role="status" aria-live="polite">
          <span className={styles.loadingLine} aria-hidden="true" />
          <span>Loading collection sources…</span>
        </div>
      ) : (
        <>
          <div className={styles.filterPanel}>
            <div className={styles.filterTop}>
              <div className={styles.searchField}>
                <Search size={15} aria-hidden="true" />
                <label htmlFor="source-search" className={styles.srOnly}>Search sources by name</label>
                <input
                  id="source-search"
                  type="search"
                  value={searchInput}
                  onChange={event => setSearchInput(event.target.value)}
                  placeholder="Search by name…"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => { setSearchInput(''); setSearchTerm('') }}
                    className={styles.clearSearch}
                    aria-label="Clear source search"
                    title="Clear search"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              {hasFilters && <span className={styles.resultMeta}>{total} results found</span>}
            </div>
            <div className={styles.filterGroups}>
              <FilterGroup
                label="Source type"
                name="sourceType"
                value={typeFilter}
                onChange={setTypeFilter}
                options={[
                  { value: '', label: 'All' },
                  { value: 'git-remote-github', label: 'GitHub' },
                  { value: 'git-remote-gitlab', label: 'GitLab' },
                  { value: 'git-remote-gitee', label: 'Gitee' },
                  { value: 'git-local', label: 'Local' },
                ]}
              />
              <FilterGroup
                label="Sync result"
                name="syncStatus"
                value={syncStatusFilter}
                onChange={setSyncStatusFilter}
                options={[
                  { value: '', label: 'All' },
                  { value: 'success', label: 'Success' },
                  { value: 'failure', label: 'Failed' },
                  { value: 'never', label: 'Never synced' },
                ]}
              />
              <FilterGroup
                label="Source status"
                name="sourceStatus"
                value={sourceStatusFilter}
                onChange={setSourceStatusFilter}
                options={[
                  { value: '', label: 'All' },
                  { value: 'enabled', label: 'Enabled' },
                  { value: 'disabled', label: 'Disabled' },
                  { value: 'unavailable', label: 'Unavailable' },
                ]}
              />
              <FilterGroup
                label="Project scope"
                name="sourceScope"
                value={scopeFilter}
                onChange={setScopeFilter}
                options={[
                  { value: '', label: 'All' },
                  { value: 'work', label: 'Work' },
                  { value: 'personal', label: 'Personal' },
                ]}
              />
            </div>
          </div>

          {error && (
            <div className={styles.errorState} role="alert">
              <strong>Sources could not be loaded</strong>
              <p>{error}</p>
              <button type="button" className={styles.secondaryButton} onClick={() => void refetch()}>
                <RefreshCw size={15} aria-hidden="true" />
                Retry
              </button>
            </div>
          )}

          {!error && total === 0 && !loading ? (
            !hasFilters ? (
              <div className={styles.emptyState}>
                <strong>No sources yet</strong>
                <p>Add a repository manually or scan a directory to begin collecting evidence.</p>
                <Link href="/collect/new" className={styles.secondaryButton}>Add source</Link>
              </div>
            ) : (
              <div className={styles.emptyState}>
                <strong>No matching sources</strong>
                <p>Change the search text or filters to see other collection sources.</p>
              </div>
            )
          ) : sources.length > 0 ? (
            <div className={styles.tableFrame} tabIndex={0} role="region" aria-label="Collection source records">
              <table className={styles.sourceTable}>
                <thead>
                  <tr>
                    <th className={styles.selectCell} scope="col">
                      <input
                        type="checkbox"
                        checked={sources.length > 0 && selectedIds.size === sources.length}
                        onChange={toggleSelectAll}
                        aria-label="Select all sources on this page"
                      />
                    </th>
                    <th className={styles.sourceCell} scope="col"><SortHeader sortBy={sortBy} sortOrder={sortOrder} onSort={setSort} column="name" label="Source" /></th>
                    <th scope="col"><SortHeader sortBy={sortBy} sortOrder={sortOrder} onSort={setSort} column="type" label="Type" /></th>
                    <th scope="col">Repository</th>
                    <th scope="col">Branches</th>
                    <th scope="col">Aliases</th>
                    <th scope="col">Emails</th>
                    <th className={styles.scopeCell} scope="col"><SortHeader sortBy={sortBy} sortOrder={sortOrder} onSort={setSort} column="projectScope" label="Project scope" /></th>
                    <th scope="col"><SortHeader sortBy={sortBy} sortOrder={sortOrder} onSort={setSort} column="status" label="Status" /></th>
                    <th scope="col">Sync result</th>
                    <th scope="col"><SortHeader sortBy={sortBy} sortOrder={sortOrder} onSort={setSort} column="lastSyncAt" label="Last sync" /></th>
                    <th scope="col">Synced through</th>
                    <th className={styles.actionsCell} scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map(source => {
                    const isSyncing = syncingIds.has(source.id)
                    const isFetching = fetchingIds.has(source.id)
                    const isSourceBusy = isSyncing || isFetching
                    const isToggling = togglingIds.has(source.id)
                    const isSelected = selectedIds.has(source.id)
                    const sourceStatus = source.status || (source.enabled ? 'enabled' : 'disabled')
                    const branchesTrunc = truncateList(getBranchNames(source.config))
                    const aliasesTrunc = truncateList(source.config.aliases || [])
                    const emailsTrunc = truncateList(source.config.authorEmails || [])
                    const syncCursor = getSyncCursor(source.config)
                    const hasSyncError = isSyncFailure(source.lastSyncStatus)
                    const syncState = source.lastSyncStatus === 'success' ? 'success' : hasSyncError ? 'failure' : 'never'
                    const statusTitle = sourceStatus === 'enabled' ? 'Click to disable' : sourceStatus === 'unavailable' ? 'Path unavailable; restore manually' : 'Click to enable'
                    const syncDisabled = isSourceBusy || source.config.authorEmails.length === 0

                    return (
                      <tr
                        key={source.id}
                        data-selected={isSelected || undefined}
                        data-error={hasSyncError || undefined}
                      >
                        <td className={styles.selectCell}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(source.id)}
                            aria-label={`Select source ${source.name}`}
                          />
                        </td>
                        <td className={styles.sourceCell}>
                          <div className={styles.sourceIdentity}>
                            <span className={styles.sourceId}>#{source.id}</span>
                            <span className={styles.sourceName} title={source.name}>{source.name}</span>
                          </div>
                        </td>
                        <td data-label="Type"><span className={styles.cellText}>{getSourceTypeLabel(source.type)}</span></td>
                        <td data-label="Repository">
                          <span className={`${styles.cellText} ${styles.pathText}`} title={source.type === 'git-local' ? source.config.owner : `${source.config.owner}/${source.config.repo}`}>
                            {source.type === 'git-local' ? source.config.owner : `${source.config.owner}/${source.config.repo}`}
                          </span>
                        </td>
                        <td data-label="Branches"><span className={styles.cellText} title={branchesTrunc.full}>{branchesTrunc.text}</span></td>
                        <td data-label="Aliases"><span className={styles.cellText} title={aliasesTrunc.full}>{aliasesTrunc.text}</span></td>
                        <td data-label="Emails"><span className={styles.cellText} title={emailsTrunc.full}>{emailsTrunc.text}</span></td>
                        <td className={styles.scopeCell} data-label="Project scope">
                          <span className={styles.scopeBadge} data-scope={source.projectScope}>
                            {source.projectScope === 'work' ? <Briefcase size={12} aria-hidden="true" /> : <User size={12} aria-hidden="true" />}
                            {source.projectScope === 'work' ? 'Work' : 'Personal'}
                          </span>
                        </td>
                        <td data-label="Status">
                          <button
                            type="button"
                            onClick={() => !isToggling && handleToggle(source.id, sourceStatus)}
                            disabled={isToggling || sourceStatus === 'unavailable'}
                            className={styles.statusBadge}
                            data-status={sourceStatus}
                            title={statusTitle}
                            aria-label={`${source.name}: ${sourceStatus}. ${statusTitle}`}
                          >
                            {isToggling ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : sourceStatus === 'enabled' ? <ToggleRight size={14} aria-hidden="true" /> : sourceStatus === 'unavailable' ? <AlertTriangle size={13} aria-hidden="true" /> : <ToggleLeft size={14} aria-hidden="true" />}
                            {sourceStatus === 'enabled' ? 'Enabled' : sourceStatus === 'unavailable' ? 'Unavailable' : 'Disabled'}
                          </button>
                        </td>
                        <td data-label="Sync result">
                          <span className={styles.syncState} data-state={syncState}>
                            {syncState === 'success' ? <CheckCircle2 size={14} aria-hidden="true" /> : syncState === 'failure' ? <XCircle size={14} aria-hidden="true" /> : <Clock size={14} aria-hidden="true" />}
                            {syncState === 'success' ? 'Success' : syncState === 'failure' ? 'Failed' : 'Not synced'}
                          </span>
                        </td>
                        <td data-label="Last sync">
                          <span className={styles.dateText} data-state={syncState === 'never' ? undefined : syncState}>
                            {source.lastSyncAt ? relativeTime(source.lastSyncAt) : 'Never synced'}
                          </span>
                        </td>
                        <td data-label="Synced through"><span className={styles.dateText}>{syncCursor || '-'}</span></td>
                        <td className={styles.actionsCell}>
                          <div className={styles.rowActions}>
                            <button
                              type="button"
                              className={styles.actionButton}
                              data-tone="primary"
                              disabled={syncDisabled}
                              onClick={() => runSync(source.id)}
                              title={source.config.authorEmails.length === 0 ? 'Configure emails first' : 'Sync new commits'}
                              aria-label={`Sync ${source.name}`}
                            >
                              {isSyncing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                              <span className={styles.actionLabel}>Sync</span>
                            </button>
                            <button
                              type="button"
                              className={styles.actionButton}
                              title={source.config.authorEmails.length === 0 ? 'Configure emails first' : 'Resync (fetch all history without duplicates)'}
                              aria-label={`Resync ${source.name}`}
                              disabled={syncDisabled}
                              onClick={() => runSync(source.id, { resync: true })}
                            >
                              <RotateCcw size={14} aria-hidden="true" />
                              <span className={styles.actionLabel}>Resync</span>
                            </button>
                            {source.type === 'git-local' && (
                              <button
                                type="button"
                                className={styles.actionButton}
                                title="Manual fetch"
                                aria-label={`Manual fetch for ${source.name}`}
                                disabled={isSourceBusy}
                                onClick={() => handleFetch(source.id)}
                              >
                                {isFetching ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                                <span className={styles.actionLabel}>Fetch</span>
                              </button>
                            )}
                            <Link href={`/collect/${source.id}`} className={styles.actionButton} title={`Edit ${source.name}`} aria-label={`Edit ${source.name}`}>
                              <Edit size={14} aria-hidden="true" />
                              <span className={styles.actionLabel}>Edit</span>
                            </Link>
                            <button
                              type="button"
                              className={styles.actionButton}
                              data-tone="danger"
                              title={`Delete ${source.name}`}
                              aria-label={`Delete ${source.name}`}
                              onClick={() => handleDelete(source.id)}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              <span className={styles.actionLabel}>Delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {totalPages > 1 && (
            <nav className={styles.pagination} aria-label="Source pages">
              <span>{total} total · Page {page} of {totalPages}</span>
              <div className={styles.pageNumbers}>
                <button
                  type="button"
                  className={styles.pageButton}
                  aria-label="Previous source page"
                  disabled={page <= 1}
                  onClick={() => setPage(current => current - 1)}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                {Array.from({ length: totalPages }, (_, index) => index + 1)
                  .filter(pageNumber => pageNumber === 1 || pageNumber === totalPages || Math.abs(pageNumber - page) <= 2)
                  .reduce<(number | 'ellipsis')[]>((acc, pageNumber, index, visiblePages) => {
                    if (index > 0 && pageNumber - (visiblePages[index - 1] as number) > 1) acc.push('ellipsis')
                    acc.push(pageNumber)
                    return acc
                  }, [])
                  .map((pageNumber, index) =>
                    pageNumber === 'ellipsis' ? (
                      <span key={`ellipsis-${index}`} aria-hidden="true">…</span>
                    ) : (
                      <button
                        type="button"
                        key={pageNumber}
                        className={styles.pageButton}
                        aria-label={`Source page ${pageNumber}`}
                        aria-current={pageNumber === page ? 'page' : undefined}
                        onClick={() => setPage(pageNumber)}
                      >
                        {pageNumber}
                      </button>
                    ),
                  )}
                <button
                  type="button"
                  className={styles.pageButton}
                  aria-label="Next source page"
                  disabled={page >= totalPages}
                  onClick={() => setPage(current => current + 1)}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </nav>
          )}

          {selectedIds.size > 0 && (
            <div className={styles.bulkBar} role="region" aria-label="Bulk source actions">
              <span className={styles.bulkCount}>{selectedIds.size} selected</span>
              <div className={styles.bulkActions}>
                <button type="button" className={styles.primaryButton} onClick={() => handleBulkUpdateScope('work')} disabled={bulkUpdating}>Set as work</button>
                <button type="button" className={styles.secondaryButton} onClick={() => handleBulkUpdateScope('personal')} disabled={bulkUpdating}>Set as personal</button>
                <button type="button" className={`${styles.secondaryButton} ${styles.dangerButton}`} onClick={handleBulkDelete} disabled={bulkUpdating}>Delete</button>
                <button type="button" className={`${styles.secondaryButton} ${styles.bulkCancel}`} onClick={() => setSelectedIds(new Set())} disabled={bulkUpdating}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
