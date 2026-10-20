'use client'
import { apiFetch } from '@/lib/api-client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { SyncResult } from '@/lib/collect/sync'
import { Button } from '@/components/ui/button'

interface SyncAllSourcesContextValue {
  isSyncing: boolean
  completionVersion: number
  runSyncAll: () => Promise<SyncResult[]>
}

const SyncAllSourcesContext = createContext<SyncAllSourcesContextValue | null>(null)

export function SyncAllSourcesProvider({ children }: { children: ReactNode }) {
  const [isSyncing, setIsSyncing] = useState(false)
  const [completionVersion, setCompletionVersion] = useState(0)
  const activeRequestRef = useRef<Promise<SyncResult[]> | null>(null)

  const runSyncAll = useCallback(() => {
    if (activeRequestRef.current) return activeRequestRef.current

    setIsSyncing(true)
    const request = apiFetch('/api/collect/git-remote/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          error?: string
          results?: unknown
        }
        if (!Array.isArray(data.results)) {
          throw new Error(
            !response.ok
              ? data.error || `Sync failed: ${response.status} ${response.statusText}`
              : 'Invalid sync response format',
          )
        }
        const results = data.results as SyncResult[]
        if (!response.ok && results.length === 0) {
          throw new Error(
            data.error || `Sync failed: ${response.status} ${response.statusText}`,
          )
        }
        setCompletionVersion((version) => version + 1)
        return results
      })
      .finally(() => {
        activeRequestRef.current = null
        setIsSyncing(false)
      })

    activeRequestRef.current = request
    return request
  }, [])

  const value = useMemo(
    () => ({ isSyncing, completionVersion, runSyncAll }),
    [completionVersion, isSyncing, runSyncAll],
  )

  return (
    <SyncAllSourcesContext.Provider value={value}>
      {children}
    </SyncAllSourcesContext.Provider>
  )
}

export function useSyncAllSources() {
  const context = useContext(SyncAllSourcesContext)
  if (!context) {
    throw new Error('useSyncAllSources must be used within SyncAllSourcesProvider')
  }
  return context
}

export function SyncAllSourcesButton() {
  const router = useRouter()
  const { isSyncing, runSyncAll } = useSyncAllSources()

  async function handleSync() {
    try {
      const results = await runSyncAll()
      if (results.length === 0) {
        toast.info('No eligible sources to sync')
        return
      }
      const failedSources = results.filter((result) => result.status === 'failed')
      const failedBranches = results.flatMap((result) =>
        (result.branches ?? [])
          .filter((branch) => branch.status === 'failed')
          .map((branch) => ({ sourceName: result.sourceName, branch })),
      )
      if (failedSources.length > 0) {
        const firstFailure = failedSources[0]
        const branchFailureSuffix = failedBranches.length > 0
          ? `; ${failedBranches.length} more branches failed`
          : ''
        toast.error(
          `Sync complete: ${results.length - failedSources.length} succeeded, ${failedSources.length} failed${branchFailureSuffix}`,
          {
          description: `${firstFailure.sourceName}: ${firstFailure.error ?? 'Sync failed'}`,
            action: {
              label: 'View details',
              onClick: () => router.push('/collect'),
            },
          },
        )
        return
      }
      if (failedBranches.length > 0) {
        const firstFailure = failedBranches[0]
        toast.warning(`Sync complete, but ${failedBranches.length} branches failed`, {
          description: `${firstFailure.sourceName} / ${firstFailure.branch.name}: ${firstFailure.branch.error ?? 'Sync failed'}`,
          action: {
              label: 'View details',
            onClick: () => router.push('/collect'),
          },
        })
        return
      }
      const eventsCount = results.reduce((total, result) => total + result.eventsCount, 0)
      toast.success(`Sync complete: ${results.length} succeeded, ${eventsCount} new events`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed')
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={isSyncing}
      aria-label="Sync all sources"
      title="Sync all sources"
      onClick={handleSync}
    >
      {isSyncing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
    </Button>
  )
}

export function CollectPageSyncButton({
  onStart,
  onResults,
}: {
  onStart?: () => void
  onResults: (results: SyncResult[]) => void
}) {
  const { isSyncing, runSyncAll } = useSyncAllSources()

  async function handleSync() {
    if (!window.confirm('Sync all enabled sources?')) return

    onStart?.()
    try {
      const results = await runSyncAll()
      if (results.length > 0) onResults(results)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed')
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={isSyncing}
      onClick={handleSync}
    >
      {isSyncing ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4 mr-2" />
      )}
      {isSyncing ? 'Syncing...' : 'Sync all'}
    </Button>
  )
}
