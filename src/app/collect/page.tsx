'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { CollectSourceList } from '@/components/CollectSourceList'
import { ScanReposDialog } from '@/components/ScanReposDialog'
import { SyncResultsCard } from '@/components/SyncResultsCard'
import {
  CollectPageSyncButton,
  useSyncAllSources,
} from '@/components/SyncAllSources'
import type { SyncResult } from '@/lib/collect/sync'
import { ArrowLeft, Plus, FolderGit2 } from 'lucide-react'

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
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">Source Management</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <CollectPageSyncButton
            onStart={() => setSyncResults(null)}
            onResults={setSyncResults}
          />
          <Button variant="outline" disabled={isSyncing} onClick={() => setScanDialogOpen(true)}>
            <FolderGit2 className="h-4 w-4 mr-2" />
            Scan directory
          </Button>
          <Link href="/collect/new">
            <Button disabled={isSyncing}>
              <Plus className="h-4 w-4 mr-2" />
              New source
            </Button>
          </Link>
        </div>
      </div>

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
  )
}
