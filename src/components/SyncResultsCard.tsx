'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'
import type { SyncResult } from '@/lib/collect/sync'
import { toast } from 'sonner'

interface SyncResultsCardProps {
  results: SyncResult[]
  onClose: () => void
  onSourceChanged?: () => void
}

export function SyncResultsCard({ results, onClose, onSourceChanged }: SyncResultsCardProps) {
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set())
  const [deletingBranches, setDeletingBranches] = useState<Set<string>>(new Set())
  const [localResults, setLocalResults] = useState<SyncResult[]>(results)

  const successCount = localResults.filter(r => r.status === 'success').length
  const failedCount = localResults.filter(r => r.status === 'failed').length

  const toggleError = (sourceId: number) => {
    setExpandedErrors(prev => {
      const next = new Set(prev)
      if (next.has(sourceId)) {
        next.delete(sourceId)
      } else {
        next.add(sourceId)
      }
      return next
    })
  }

  const handleDeleteBranch = async (sourceId: number, branchName: string) => {
    if (!confirm(`Remove branch ${branchName} from this source?`)) return

    const key = `${sourceId}-${branchName}`
    setDeletingBranches(prev => new Set(prev).add(key))

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

      // 从本地结果中移除该分支
      setLocalResults(prev =>
        prev.map(result => {
          if (result.sourceId !== sourceId || !result.branches) return result

          const updatedBranches = result.branches.filter(b => b.name !== branchName)

          return {
            ...result,
            branches: updatedBranches,
          }
        })
      )

      // 通知父组件刷新列表
      onSourceChanged?.()

      toast.success(`Branch ${branchName} removed`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove branch')
    } finally {
      setDeletingBranches(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <span>Sync results</span>
          <div className="flex gap-2">
            <Badge variant="default" className="bg-green-600">
              {successCount} succeeded
            </Badge>
            <Badge
              variant={failedCount > 0 ? 'destructive' : 'secondary'}
            >
              {failedCount} failed
            </Badge>
          </div>
        </CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
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
      </CardContent>
    </Card>
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

  if (status === 'failed') {
    const isLongError = error && error.length > 100
    return (
      <div className="flex items-start gap-3 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
        <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{sourceName}</div>
          {error && (
            <div className="mt-1">
              <div
                className={cn(
                  'text-sm text-muted-foreground break-words',
                  !expanded && isLongError && 'line-clamp-2'
                )}
              >
                {error}
              </div>
              {isLongError && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onToggle}
                  className="h-6 px-2 mt-1 text-xs"
                >
                  {expanded ? (
                    <>
                      Collapse <ChevronUp className="h-3 w-3 ml-1" />
                    </>
                  ) : (
                    <>
                      Expand <ChevronDown className="h-3 w-3 ml-1" />
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 检查是否有失败的分支需要展示明细
  const hasFailedBranches = branches && branches.some(b => b.status === 'failed')
  // 单分支源不展示分支明细
  const isMultiBranch = branches && branches.length > 1 && branches.some(b => b.name)

  if (hasFailedBranches && isMultiBranch) {
    return (
      <div className="flex items-start gap-3 p-3 rounded-lg bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/20 dark:border-yellow-900/30">
        <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{sourceName}</div>
          <div className="text-sm text-muted-foreground mt-1">
            Sync succeeded, but some branches failed
          </div>
          <div className="mt-2 space-y-1.5">
            {branches.map((branch) => {
              const branchKey = `${result.sourceId}-${branch.name}`
              const isDeleting = deletingBranches.has(branchKey)

              return (
                <div
                  key={branch.name}
                  className={cn(
                    'flex items-start gap-2 text-xs rounded px-2 py-1.5',
                    branch.status === 'failed'
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400'
                  )}
                >
                  {branch.status === 'success' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{branch.name}</span>
                    {branch.status === 'success' ? (
                      <span className="ml-2 text-muted-foreground">
                        {branch.commitsCount} commits
                      </span>
                    ) : (
                      <span className="ml-2 break-words">{branch.error}</span>
                    )}
                  </div>
                  {branch.status === 'failed' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 hover:text-destructive"
                      onClick={() => onDeleteBranch(result.sourceId, branch.name)}
                      disabled={isDeleting}
                      title="Remove this branch"
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            commits: {commitsCount}, events: {eventsCount}
          </div>
        </div>
      </div>
    )
  }

  if (warnings && warnings.length > 0) {
    return (
      <div className="flex items-start gap-3 p-3 rounded-lg bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/20 dark:border-yellow-900/30">
        <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{sourceName}</div>
          <div className="text-sm text-muted-foreground mt-1">
            Sync succeeded, but some paths failed
          </div>
          <ul className="mt-2 space-y-1">
            {warnings.map((warning, idx) => (
              <li
                key={idx}
                className="text-xs text-muted-foreground break-words"
              >
                • {warning}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-xs text-muted-foreground">
            commits: {commitsCount}, events: {eventsCount}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{sourceName}</div>
      </div>
      <div className="text-xs text-muted-foreground">
        commits: {commitsCount}, events: {eventsCount}
      </div>
    </div>
  )
}
