'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Scan, FolderGit2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import styles from '@/components/collection-sources.module.css'

interface DirectoryItem {
  name: string
  path: string
}

interface FoundRepo {
  path: string
  name: string
  alreadyAdded: boolean
  authorEmails: string[]
}

interface ScanReposDialogProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

type ScanReposResult = { repos: FoundRepo[]; error?: string }
type BatchAddSourcesResult = { success: boolean; addedCount: number; error?: string }

/**
 * POST 到 B4 增补路由（ADR-0030）：路径与请求体 1:1 镜像原来的
 * `scanRepos` / `batchAddSources` server action。
 *
 * 这两条路由的业务结果一律 200 + 内嵌 `error` 字段，所以调用点先看字段；
 * 只有 HTTP 层（withAuth/audit、网关）才会给出非 2xx —— 那属于传输失败，
 * 抛出后落到与 server action 时代一致的通用 catch 文案。
 */
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // 业务错误不会走到这里（路由一律 200 + 内嵌 error）；非 2xx 只来自
    // withAuth/audit 或网关，按传输失败交给调用点的通用 catch。
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export function ScanReposDialog(props: ScanReposDialogProps) {
  if (!props.open) return null
  return <ScanReposDialogContent {...props} />
}

function ScanReposDialogContent({
  open,
  onClose,
  onSuccess,
}: ScanReposDialogProps) {
  const [step, setStep] = useState<'scan' | 'result'>('scan')
  const [path, setPath] = useState('')
  const [suggestions, setSuggestions] = useState<DirectoryItem[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [repos, setRepos] = useState<FoundRepo[]>([])
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanMessage, setScanMessage] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchSuggestions = useCallback(async (currentPath: string) => {
    try {
      setFetchError(null)
      const res = await apiFetch(`/api/collect/scan-path?path=${encodeURIComponent(currentPath)}`)
      const data = await res.json()

      if (data.error) {
        setSuggestions([])
        setShowSuggestions(false)
        setFetchError(data.error + traceSuffix(res))
        return
      }

      setSuggestions(data.directories || [])
      setShowSuggestions(true)
      setActiveIndex(-1)
    } catch {
      setSuggestions([])
      setShowSuggestions(false)
      setFetchError('Network error. Unable to load directory list.')
    }
  }, [])

  useEffect(() => {
    if (path.length > 0) {
      const timer = setTimeout(() => fetchSuggestions(path), 200)
      return () => clearTimeout(timer)
    }
  }, [path, fetchSuggestions])

  function handleSuggestionClick(suggestion: DirectoryItem) {
    setPath(suggestion.path)
    setShowSuggestions(false)
    setActiveIndex(-1)
    inputRef.current?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (!showSuggestions || suggestions.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(previous => (previous + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(previous => (previous - 1 + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      handleSuggestionClick(suggestions[activeIndex])
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const target = activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0]
      handleSuggestionClick(target)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setShowSuggestions(false)
      setActiveIndex(-1)
    }
  }

  async function handleScan() {
    if (!path.trim()) {
      toast.error('Please enter a path')
      return
    }

    setScanning(true)
    setScanError(null)
    setScanMessage(null)
    try {
      const result = await postJSON<ScanReposResult>('/api/collect/scan-repos', {
        basePath: path,
        maxDepth: 3,
      })

      if (result.error) {
        toast.error(result.error)
        setScanError(result.error)
        return
      }

      if (result.repos.length === 0) {
        toast.info('No Git repositories found')
        setScanMessage('No Git repositories found in this directory. Try a parent directory or another path.')
        return
      }

      setRepos(result.repos.map(repo => ({
        ...repo,
        authorEmails: [],
      })))
      setStep('result')
      toast.success(`Found ${result.repos.length} Git repositories`)
    } catch {
      toast.error('Scan failed')
      setScanError('Scan failed. Check the directory path and try again.')
    } finally {
      setScanning(false)
    }
  }

  function handleToggleRepo(repoPath: string) {
    const nextSelected = new Set(selectedRepos)
    if (nextSelected.has(repoPath)) nextSelected.delete(repoPath)
    else nextSelected.add(repoPath)
    setSelectedRepos(nextSelected)
  }

  function handleSelectAll() {
    const selectable = repos.filter(repo => !repo.alreadyAdded)
    const allSelected = selectable.every(repo => selectedRepos.has(repo.path))
    if (allSelected) {
      setSelectedRepos(new Set())
    } else {
      setSelectedRepos(new Set(selectable.map(repo => repo.path)))
    }
  }

  async function handleBatchAdd() {
    const selected = repos.filter(repo => selectedRepos.has(repo.path))

    if (selected.length === 0) {
      toast.error('Select repositories to add')
      return
    }

    setAdding(true)
    setAddError(null)
    try {
      const result = await postJSON<BatchAddSourcesResult>('/api/collect/batch-add-sources', {
        // 路由只吃 {path, name, authorEmails}；alreadyAdded 是本地选择态。
        repos: selected.map(repo => ({
          path: repo.path,
          name: repo.name,
          authorEmails: repo.authorEmails,
        })),
      })

      if (result.success) {
        toast.success(result.addedCount > 0 ? `Created ${result.addedCount} sources` : 'Nothing to add')
        onSuccess()
        onClose()
      } else {
        const message = result.error || 'Add failed'
        setAddError(message)
        toast.error(message)
      }
    } catch {
      setAddError('Add failed')
      toast.error('Add failed')
    } finally {
      setAdding(false)
    }
  }

  const busy = scanning || adding

  return (
    <Dialog open={open} onOpenChange={nextOpen => {
      if (!nextOpen && !busy) onClose()
    }}>
      <DialogContent className={`${styles.dialogContent} sm:max-w-[760px]`} showCloseButton={!busy}>
        {step === 'scan' ? (
          <>
            <DialogHeader className={styles.dialogHeader}>
              <div className={styles.dialogHeaderText}>
                <DialogTitle>Scan Git repositories</DialogTitle>
                <DialogDescription className={styles.dialogDescription}>
                  Look through a local directory and add repositories as individual collection sources.
                </DialogDescription>
              </div>
              <FolderGit2 size={19} aria-hidden="true" />
            </DialogHeader>
            <div className={styles.dialogBody}>
              <div className={styles.fieldsGrid}>
                <div className={`${styles.field} ${styles.fieldWide}`}>
                  <label htmlFor="scan-path">Directory to scan</label>
                  <div className={styles.pathField}>
                    <input
                      ref={inputRef}
                      id="scan-path"
                      type="text"
                      value={path}
                      onChange={event => {
                        const nextPath = event.target.value
                        setPath(nextPath)
                        if (!nextPath) {
                          setSuggestions([])
                          setShowSuggestions(false)
                        }
                      }}
                      onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                      onKeyDown={handleKeyDown}
                      placeholder="/home/user/projects"
                      disabled={scanning}
                      className={styles.textInput}
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={showSuggestions && suggestions.length > 0}
                      aria-controls="scan-path-suggestions"
                      aria-activedescendant={activeIndex >= 0 ? `scan-path-option-${activeIndex}` : undefined}
                      aria-describedby={`scan-path-help${fetchError ? ' scan-path-error' : ''}`}
                      autoFocus
                    />
                    {showSuggestions && suggestions.length > 0 && (
                      <div id="scan-path-suggestions" className={styles.pathSuggestions} role="listbox" aria-label="Directory suggestions">
                        {suggestions.map((suggestion, index) => (
                          <button
                            type="button"
                            id={`scan-path-option-${index}`}
                            role="option"
                            aria-selected={index === activeIndex}
                            tabIndex={-1}
                            key={suggestion.path}
                            onMouseDown={event => event.preventDefault()}
                            onClick={() => handleSuggestionClick(suggestion)}
                            className={styles.pathSuggestion}
                            data-active={index === activeIndex || undefined}
                          >
                            <span>{suggestion.name}</span>
                            <span>{suggestion.path}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p id="scan-path-help" className={styles.fieldHelp}>
                    Enter a path to see subdirectory suggestions. Fuzzy search and paths beginning with ~ are supported (for example, ~/git).
                  </p>
                </div>
              </div>
              {fetchError && <p id="scan-path-error" className={styles.inlineError} role="alert">{fetchError}</p>}
              {scanError && <p className={styles.inlineError} role="alert">{scanError}</p>}
              {scanMessage && <div className={styles.emptyState} role="status"><strong>No repositories found</strong><p>{scanMessage}</p></div>}
              {scanning && (
                <div className={styles.loadingState} role="status">
                  <span className={styles.loadingLine} aria-hidden="true" />
                  <span>Scanning up to three directory levels…</span>
                </div>
              )}
            </div>
            <div className={styles.dialogFooter}>
              <button type="button" className={styles.primaryButton} onClick={handleScan} disabled={scanning || !path.trim()}>
                {scanning ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Scan size={15} aria-hidden="true" />}
                {scanning ? 'Scanning…' : 'Scan directory'}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={scanning}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className={styles.dialogHeader}>
              <div className={styles.dialogHeaderText}>
                <DialogTitle>Scan results</DialogTitle>
                <DialogDescription className={styles.dialogDescription}>
                  {repos.length} repositories found. Select the records to add; existing sources are marked Added.
                </DialogDescription>
              </div>
            </DialogHeader>
            <div className={styles.dialogBody}>
              {addError && <p className={styles.inlineError} role="alert">{addError}</p>}
              <div className={styles.repoGrid}>
                {repos.map(repo => (
                  <label key={repo.path} className={styles.repoOption} data-added={repo.alreadyAdded || undefined}>
                    <input
                      type="checkbox"
                      checked={selectedRepos.has(repo.path)}
                      onChange={() => handleToggleRepo(repo.path)}
                      disabled={repo.alreadyAdded}
                    />
                    <span className={styles.repoText}>
                      <strong>{repo.name}{repo.alreadyAdded ? ' · Added' : ''}</strong>
                      <small>{repo.path}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className={styles.dialogFooter}>
              <button type="button" className={styles.secondaryButton} onClick={handleSelectAll}>
                {repos.filter(repo => !repo.alreadyAdded).every(repo => selectedRepos.has(repo.path)) && repos.some(repo => !repo.alreadyAdded)
                  ? 'Clear all' : 'Select all'}
              </button>
              <span className={styles.footerSpacer} />
              <button type="button" className={styles.primaryButton} onClick={handleBatchAdd} disabled={adding || selectedRepos.size === 0}>
                {adding && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                {adding ? 'Adding…' : `Add selected (${selectedRepos.size})`}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={adding}>Cancel</button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
