import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect } from 'react'
import { CheckSquare, Square, Loader2, UserCircle, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import styles from './collection-sources.module.css'

export interface AuthorInfo {
  email: string
  name: string
  count: number
}

interface AuthorEmailPickerProps {
  open: boolean
  onClose: () => void
  onConfirm: (emails: string[]) => void
  currentEmails: string[]
  repoParams: {
    sourceId?: number
    type: string
    path?: string
    owner?: string
    repo?: string
    token?: string
    baseUrl?: string
    branch?: string
  }
}

export function AuthorEmailPicker(props: AuthorEmailPickerProps) {
  if (!props.open) return null
  return <AuthorEmailPickerContent {...props} />
}

function AuthorEmailPickerContent({
  open,
  onClose,
  onConfirm,
  currentEmails,
  repoParams,
}: AuthorEmailPickerProps) {
  const [authors, setAuthors] = useState<AuthorInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(currentEmails))
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    const params = new URLSearchParams({ type: repoParams.type })
    if (repoParams.sourceId) params.set('sourceId', String(repoParams.sourceId))
    if (repoParams.path) params.set('path', repoParams.path)
    if (repoParams.owner) params.set('owner', repoParams.owner)
    if (repoParams.repo) params.set('repo', repoParams.repo)
    if (repoParams.token) params.set('token', repoParams.token)
    if (repoParams.baseUrl) params.set('baseUrl', repoParams.baseUrl)
    if (repoParams.branch) params.set('branch', repoParams.branch)

    let active = true
    apiFetch(`/api/collect/sources/emails?${params}`)
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error((data.error || 'Failed to load authors') + traceSuffix(res))
        if (active) setAuthors(data.authors || [])
      })
      .catch(reason => {
        if (!active) return
        setAuthors([])
        setError(reason instanceof Error ? reason.message : 'Failed to load authors')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [requestVersion, repoParams.sourceId, repoParams.type, repoParams.path, repoParams.owner, repoParams.repo, repoParams.token, repoParams.baseUrl, repoParams.branch])

  function toggleEmail(email: string) {
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  function handleSelectAll() {
    setSelected(new Set(authors.map(author => author.email)))
  }

  function handleDeselectAll() {
    setSelected(new Set())
  }

  function handleConfirm() {
    onConfirm([...selected])
    onClose()
  }

  const allSelected = authors.length > 0 && authors.every(author => selected.has(author.email))
  const someSelected = selected.size > 0 && !allSelected

  return (
    <Dialog open={open} onOpenChange={nextOpen => {
      if (!nextOpen) onClose()
    }}>
      <DialogContent className={`${styles.dialogContent} ${styles.authorDialog} sm:max-w-[590px]`}>
        <DialogHeader className={styles.dialogHeader}>
          <div className={styles.dialogHeaderText}>
            <DialogTitle>Select author emails</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              Choose the commit identities to collect from this repository. Counts show matching commits.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className={styles.dialogToolbar}>
          <button
            type="button"
            onClick={allSelected ? handleDeselectAll : handleSelectAll}
            className={styles.textButton}
            disabled={loading || authors.length === 0}
          >
            {allSelected ? <CheckSquare size={15} aria-hidden="true" /> : <Square size={15} aria-hidden="true" />}
            {allSelected ? 'Clear all' : 'Select all'}
          </button>
          <span role="status">Selected {selected.size} / {authors.length}{someSelected ? ' · Partial selection' : ''}</span>
        </div>

        <div className={`${styles.dialogBody} ${styles.authorDialogBody}`} aria-busy={loading}>
          {loading ? (
            <div className={styles.loadingState} role="status">
              <span className={styles.loadingLine} aria-hidden="true" />
              <span><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading authors…</span>
            </div>
          ) : error ? (
            <div className={`${styles.errorState} ${styles.dialogError}`} role="alert">
              <strong>Authors could not be loaded</strong>
              <p>{error}</p>
              <button type="button" className={styles.secondaryButton} onClick={() => {
                setLoading(true)
                setError(null)
                setRequestVersion(version => version + 1)
              }}>
                <RefreshCw size={14} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : authors.length === 0 ? (
            <div className={styles.dialogEmpty}>
              <strong>No author information found</strong>
              <p>Enter a repository path or access token first, then reopen this picker.</p>
            </div>
          ) : (
            <div className={styles.authorList}>
              {authors.map(author => {
                const isChecked = selected.has(author.email)
                return (
                  <button
                    type="button"
                    key={author.email}
                    onClick={() => toggleEmail(author.email)}
                    className={styles.authorRow}
                    aria-pressed={isChecked}
                  >
                    {isChecked ? <CheckSquare size={17} aria-hidden="true" /> : <Square size={17} aria-hidden="true" />}
                    <UserCircle size={17} aria-hidden="true" />
                    <span className={styles.authorIdentity}>
                      <strong>{author.name}</strong>
                      <span>{author.email}</span>
                    </span>
                    <span className={styles.authorCount}>{author.count} {author.count === 1 ? 'commit' : 'commits'}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className={styles.dialogFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>Cancel</button>
          <button type="button" className={styles.primaryButton} onClick={handleConfirm} disabled={selected.size === 0}>
            Confirm selection ({selected.size})
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
