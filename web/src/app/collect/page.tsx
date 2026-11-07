import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router'
import { CollectSourceList } from '@/components/CollectSourceList'
import { ScanReposDialog } from '@/components/ScanReposDialog'
import { SyncResultsCard } from '@/components/SyncResultsCard'
import {
  CollectPageSyncButton,
  useSyncAllSources,
} from '@/components/SyncAllSources'
import type { SyncResult } from '@/lib/collect/sync'
import { ArrowLeft, Plus, FolderGit2 } from 'lucide-react'
import styles from '@/components/collection-sources.module.css'

export default function CollectPage() {
  const [scanDialogOpen, setScanDialogOpen] = useState(false)
  const [syncResults, setSyncResults] = useState<SyncResult[] | null>(null)
  const refreshFnRef = useRef<(() => void) | null>(null)
  const { isSyncing, completionVersion } = useSyncAllSources()
  const observedCompletionVersionRef = useRef(completionVersion)

  const handleRefreshReady = useCallback((fetchFn: () => void) => {
    refreshFnRef.current = fetchFn
  }, [])

  const handleScanSuccess = () => {
    if (refreshFnRef.current) {
      refreshFnRef.current()
    }
  }

  useEffect(() => {
    if (completionVersion === observedCompletionVersionRef.current) return
    observedCompletionVersionRef.current = completionVersion
    refreshFnRef.current?.()
  }, [completionVersion])

  return (
    <div className={styles.surface}>
      <div className={styles.primary}>
        <header className={styles.pageHeading}>
          <div className={styles.headingText}>
            <h1>Collection sources</h1>
            <p className={styles.description}>
              Manage Git repositories, author identities, project scope, and the branch cursors used to collect work evidence.
            </p>
          </div>
          <div className={styles.pageActions}>
            <Link to="/" className={styles.secondaryButton}>
              <ArrowLeft size={16} aria-hidden="true" />
              Timeline
            </Link>
            <CollectPageSyncButton
              onStart={() => setSyncResults(null)}
              onResults={setSyncResults}
            />
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={isSyncing}
              onClick={() => setScanDialogOpen(true)}
            >
              <FolderGit2 size={16} aria-hidden="true" />
              Scan directory
            </button>
            <Link
              to="/collect/new"
              className={styles.primaryButton}
              aria-disabled={isSyncing || undefined}
              tabIndex={isSyncing ? -1 : undefined}
              onClick={event => {
              if (isSyncing) event.preventDefault()
            }}>
              <Plus size={16} aria-hidden="true" />
              New source
            </Link>
          </div>
        </header>

        {syncResults && (
          <SyncResultsCard
            results={syncResults}
            onClose={() => setSyncResults(null)}
            onSourceChanged={() => refreshFnRef.current?.()}
          />
        )}

        <CollectSourceList onRefresh={handleRefreshReady} />

        <ScanReposDialog
          open={scanDialogOpen}
          onClose={() => setScanDialogOpen(false)}
          onSuccess={handleScanSuccess}
        />
      </div>
    </div>
  )
}
