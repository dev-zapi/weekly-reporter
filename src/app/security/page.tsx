'use client'

import { useState, useEffect, useCallback } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import { Copy, Plus, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import { formatSystemDateTime } from '@/lib/time-format'
import {
  getPatStatus,
  type AuditRecord,
  type CreatedPat,
  type PatMetadata,
  type PatStatus,
} from '@/lib/auth/pat-shared'
import styles from './security.module.css'

function formatStatus(status: PatStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status">
      <span className={styles.loadingLine} aria-hidden="true" />
      <strong>{label}</strong>
    </div>
  )
}

function LoadError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className={styles.errorState} role="alert">
      <strong>Unable to load security records</strong>
      <p>{message}</p>
      <button type="button" className={styles.secondaryButton} onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function RevokeButton({
  id,
  name,
  revoking,
  onRevoke,
}: {
  id: number
  name: string
  revoking: boolean
  onRevoke: (id: number, name: string) => void
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        className={styles.dangerButton}
        aria-label={`Revoke ${name}`}
        aria-busy={revoking}
        disabled={revoking}
      >
        {revoking ? 'Revoking…' : 'Revoke'}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={styles.dialogBackdrop} />
        <AlertDialog.Viewport className={styles.dialogViewport}>
          <AlertDialog.Popup className={styles.dialogPopup}>
            <AlertDialog.Title className={styles.dialogTitle}>
              Revoke PAT &quot;{name}&quot;?
            </AlertDialog.Title>
            <AlertDialog.Description className={styles.dialogDescription}>
              This cannot be undone. Future API calls with this token will be blocked;
              existing audit records are retained.
            </AlertDialog.Description>
            <div className={styles.dialogActions}>
              <AlertDialog.Close className={styles.secondaryButton}>
                Cancel
              </AlertDialog.Close>
              <AlertDialog.Close
                className={styles.dangerButton}
                onClick={() => onRevoke(id, name)}
              >
                Revoke PAT
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export default function SecurityPage() {
  return (
    <div className={styles.workspace}>
      <header className={styles.pageHeading}>
        <h1>Security</h1>
        <p>Manage personal access tokens and inspect the API audit trail.</p>
      </header>

      <Tabs defaultValue="pats" className={styles.tabs}>
        <TabsList className={styles.tabsList} aria-label="Security records">
          <TabsTrigger value="pats" className={styles.tabsTrigger}>
            <span>Personal Access Tokens</span>
            <small>Create and revoke credentials</small>
          </TabsTrigger>
          <TabsTrigger value="audit" className={styles.tabsTrigger}>
            <span>Audit Log</span>
            <small>Inspect authenticated API calls</small>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pats">
          <PatSection />
        </TabsContent>

        <TabsContent value="audit">
          <AuditSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function PatSection() {
  const [pats, setPats] = useState<PatMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [name, setName] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<number | null>(null)
  const [justCreated, setJustCreated] = useState<CreatedPat | null>(null)
  const [copied, setCopied] = useState(false)

  const loadPats = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setLoadError('')
    try {
      const res = await apiFetch('/api/auth/pats')
      if (!res.ok) {
        const err = await res.json()
        throw new Error((err.error || 'Failed to load PATs') + traceSuffix(res))
      }
      const data = await res.json()
      setPats(data.pats ?? [])
    } catch (err) {
      console.error('Failed to load PATs:', err)
      const message = err instanceof Error ? err.message : 'Failed to load PATs'
      setLoadError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPats(true)
  }, [loadPats])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setCreating(true)
    setMutationError('')
    try {
      const body: { name: string; expiresAt?: number } = { name: name.trim() }
      if (expiresAt) {
        body.expiresAt = Math.floor(new Date(expiresAt).getTime())
      }
      const res = await apiFetch('/api/auth/pats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error((err.error || 'Failed to create PAT') + traceSuffix(res))
      }
      const created: CreatedPat = await res.json()
      setJustCreated(created)
      setName('')
      setExpiresAt('')
      toast.success('PAT created')
      await loadPats()
    } catch (err) {
      console.error('Create PAT failed:', err)
      const message = err instanceof Error ? err.message : 'Failed to create PAT'
      setMutationError(message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: number, patName: string) => {
    setMutationError('')
    setRevokingId(id)
    try {
      const res = await apiFetch(`/api/auth/pats/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error((err.error || 'Failed to revoke PAT') + traceSuffix(res))
      }
      toast.success(`PAT "${patName}" revoked`)
      await loadPats()
    } catch (err) {
      console.error('Revoke failed:', err)
      const message = err instanceof Error ? err.message : 'Failed to revoke PAT'
      setMutationError(message)
      toast.error(message)
    } finally {
      setRevokingId(null)
    }
  }

  const handleCopy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      toast.success('Token copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Copy failed:', err)
      toast.error('Failed to copy token')
    }
  }

  if (loading) {
    return <LoadingState label="Loading tokens…" />
  }

  return (
    <div className={styles.sectionStack}>
      <section className={styles.panel} aria-labelledby="create-token-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="create-token-heading">Create new token</h2>
            <p>Generate a credential for scripted API access.</p>
          </div>
        </div>
        <form onSubmit={handleCreate} className={styles.createForm}>
          <div className={styles.field}>
            <label htmlFor="pat-name">Token name</label>
            <input
              id="pat-name"
              className={styles.input}
              placeholder="Token name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={creating}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="pat-expires">Expires (optional)</label>
            <input
              id="pat-expires"
              className={styles.input}
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={creating}
            />
          </div>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={creating || !name.trim()}
            aria-busy={creating}
          >
            <Plus size={16} aria-hidden="true" />
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      </section>

      {mutationError && (
        <div className={styles.errorState} role="alert">
          <strong>Token operation failed</strong>
          <p>{mutationError}</p>
        </div>
      )}

      {justCreated && (
        <section className={styles.tokenNotice} aria-label="Newly created token">
          <div className={styles.tokenWarning}>
            <AlertTriangle size={17} aria-hidden="true" />
            <strong>This token is only shown once — save it now.</strong>
          </div>
          <div className={styles.tokenCopyRow}>
            <code data-testid="new-token-value" className={styles.tokenValue}>
              {justCreated.token}
            </code>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => handleCopy(justCreated.token)}
              aria-label="Copy token"
            >
              <Copy size={15} aria-hidden="true" />
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p>This token cannot be viewed again. If you lose it, create a new one.</p>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setJustCreated(null)}
          >
            Dismiss
          </button>
        </section>
      )}

      <section className={styles.recordsSection} aria-labelledby="existing-tokens-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="existing-tokens-heading">Existing tokens</h2>
            <p>Revocation is permanent and immediately blocks future API access.</p>
          </div>
          {!loadError && (
            <span>
              {pats.length} {pats.length === 1 ? 'record' : 'records'}
            </span>
          )}
        </div>

        {loadError ? (
          <LoadError message={loadError} onRetry={() => loadPats(true)} />
        ) : pats.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>No tokens yet</strong>
            <p>No PATs yet. Create one above to get started.</p>
          </div>
        ) : (
          <ol className={styles.recordList}>
            {pats.map((pat) => {
              const status = getPatStatus(pat)
              return (
                <li key={pat.id} className={styles.patRecord}>
                  <span className={styles.recordId}>#{pat.id}</span>
                  <div className={styles.recordMain}>
                    <div className={styles.recordTopline}>
                      <h3>{pat.name}</h3>
                      <span className={styles.statusBadge} data-status={status}>
                        {formatStatus(status)}
                      </span>
                    </div>
                    <dl className={styles.patDetails}>
                      <div>
                        <dt>Prefix</dt>
                        <dd>{pat.prefix}</dd>
                      </div>
                      <div>
                        <dt>Created</dt>
                        <dd>{formatSystemDateTime(pat.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Last used</dt>
                        <dd>
                          {pat.lastUsedAt ? formatSystemDateTime(pat.lastUsedAt) : 'Never'}
                        </dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>
                          {pat.expiresAt ? formatSystemDateTime(pat.expiresAt) : 'Never'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  {status === 'active' && (
                    <RevokeButton
                      id={pat.id}
                      name={pat.name}
                      revoking={revokingId === pat.id}
                      onRevoke={handleRevoke}
                    />
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}

function AuditSection() {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [limit] = useState(50)
  const [offset, setOffset] = useState(0)
  // Input values vs. applied filters: typing does not refetch; the Search
  // button (or pagination) commits the inputs into the applied state.
  const [patNameInput, setPatNameInput] = useState('')
  const [statusInput, setStatusInput] = useState('')
  const [patNameFilter, setPatNameFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const loadRecords = useCallback(
    async (currentOffset: number, patName: string, status: string) => {
      setLoading(true)
      setLoadError('')
      try {
        const params = new URLSearchParams()
        params.set('limit', String(limit))
        params.set('offset', String(currentOffset))
        if (patName.trim()) params.set('patName', patName.trim())
        if (status.trim()) params.set('status', status.trim())

        const res = await apiFetch(`/api/audit?${params.toString()}`)
        if (!res.ok) {
          const err = await res.json()
          throw new Error((err.error || 'Failed to load audit log') + traceSuffix(res))
        }
        const data = await res.json()
        setRecords(data.records ?? [])
        setTotal(data.total ?? 0)
      } catch (err) {
        console.error('Failed to load audit records:', err)
        const message = err instanceof Error ? err.message : 'Failed to load audit log'
        setLoadError(message)
        toast.error(message)
      } finally {
        setLoading(false)
      }
    },
    [limit],
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecords(offset, patNameFilter, statusFilter)
  }, [loadRecords, offset, patNameFilter, statusFilter])

  const handleSearch = () => {
    setOffset(0)
    setPatNameFilter(patNameInput)
    setStatusFilter(statusInput)
  }

  const handleNext = () => {
    if (offset + limit < total) {
      setOffset(offset + limit)
    }
  }

  const handlePrev = () => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit))
    }
  }

  return (
    <div className={styles.sectionStack}>
      <section className={styles.panel} aria-labelledby="audit-filter-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="audit-filter-heading">Filter audit records</h2>
            <p>Search by token name and HTTP response status.</p>
          </div>
        </div>
        <form
          className={styles.filterForm}
          onSubmit={(event) => {
            event.preventDefault()
            handleSearch()
          }}
        >
          <div className={styles.field}>
            <label htmlFor="audit-pat-name">PAT name</label>
            <input
              id="audit-pat-name"
              className={styles.input}
              placeholder="PAT name"
              value={patNameInput}
              onChange={(e) => setPatNameInput(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="audit-status">Status</label>
            <input
              id="audit-status"
              className={styles.input}
              placeholder="Status"
              inputMode="numeric"
              value={statusInput}
              onChange={(e) => setStatusInput(e.target.value)}
            />
          </div>
          <button type="submit" className={styles.primaryButton}>
            Search
          </button>
        </form>
      </section>

      <section className={styles.recordsSection} aria-labelledby="audit-records-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="audit-records-heading">API call records</h2>
            <p>Trace metadata is retained with each authenticated request.</p>
          </div>
          {!loading && !loadError && <span>{total} total</span>}
        </div>

        {loading ? (
          <LoadingState label="Loading audit records…" />
        ) : loadError ? (
          <LoadError
            message={loadError}
            onRetry={() => loadRecords(offset, patNameFilter, statusFilter)}
          />
        ) : records.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>No matching records</strong>
            <p>No audit records found. Adjust the filters or create API activity with a PAT.</p>
          </div>
        ) : (
          <>
            <ol className={styles.recordList}>
              {records.map((record) => (
                <li key={record.id} className={styles.auditRecord}>
                  <span className={styles.recordId}>#{record.id}</span>
                  <div className={styles.recordMain}>
                    <div className={styles.recordTopline}>
                      <div>
                        <h3 className={styles.auditTitle}>
                          <span>{record.method}</span>
                          <span>{record.apiPath}</span>
                        </h3>
                        <p className={styles.recordTime}>
                          {formatSystemDateTime(record.createdAt)}
                        </p>
                      </div>
                      <span
                        className={styles.statusBadge}
                        data-status={record.status >= 400 ? 'error' : 'success'}
                      >
                        {record.status}
                      </span>
                    </div>
                    <dl className={styles.auditDetails}>
                      <div>
                        <dt>PAT name</dt>
                        <dd>{record.patName ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>Agent</dt>
                        <dd>{record.agentIdentity ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>CWD</dt>
                        <dd>{record.callerCwd ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>User-Agent</dt>
                        <dd>{record.userAgent ?? '—'}</dd>
                      </div>
                    </dl>
                  </div>
                </li>
              ))}
            </ol>

            <div className={styles.pagination}>
              <span className={styles.pageSummary}>
                {`Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}
              </span>
              <div className={styles.paginationActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={offset === 0}
                  onClick={handlePrev}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={offset + limit >= total}
                  onClick={handleNext}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
