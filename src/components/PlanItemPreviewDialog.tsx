'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PLAN_ITEM_STATUS_COLORS, PLAN_ITEM_STATUS_LABELS } from '@/lib/plan-item-display'
import type { PeriodPlanItemStatus, ProjectScope, PeriodPlanScope } from '@/lib/db/schema'

interface PlanItemPreviewDialogProps {
  itemId: number | null
  onClose: () => void
  onGoToPlans: (scope: PeriodPlanScope, periodStart: string) => void
}

interface PlanItemPeriod {
  id: number
  scope: PeriodPlanScope
  periodStart: string
  periodEnd: string
}

interface PlanItemData {
  id: number
  text: string
  status: PeriodPlanItemStatus
  projectScope: ProjectScope
  period: PlanItemPeriod | null
  deferralChain: number[]
}

/**
 * Read-only preview of a plan item referenced from event content via `%<id>`.
 * Mirrors ReferencePreviewDialog: fetch by id, show a dangling message on 404,
 * and offer a deep link into /plans for the owning period.
 */
export function PlanItemPreviewDialog({ itemId, onClose, onGoToPlans }: PlanItemPreviewDialogProps) {
  const [item, setItem] = useState<PlanItemData | null>(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (itemId === null) {
      setItem(null)
      setNotFound(false)
      return
    }

    setLoading(true)
    setNotFound(false)
    fetch(`/api/plan-items/${itemId}`)
      .then((res) => {
        if (res.status === 404) {
          setNotFound(true)
          return null
        }
        return res.json()
      })
      .then((data) => {
        if (data) setItem(data)
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [itemId])

  const period = item?.period ?? null

  return (
    <Dialog open={itemId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {loading ? 'Loading…' : notFound ? '条目不存在' : item ? `Plan Item %${item.id}` : ''}
          </DialogTitle>
          <DialogDescription>
            {loading
              ? 'Fetching plan item details…'
              : notFound
                ? '该计划条目不存在或已被删除。'
                : 'Plan item preview'}
          </DialogDescription>
        </DialogHeader>

        {!loading && !notFound && item && (
          <div className="space-y-3">
            <div className="text-sm whitespace-pre-line border rounded-md p-3 bg-muted/50">
              {item.text}
            </div>

            <div className="flex flex-wrap gap-1.5">
              <Badge className={PLAN_ITEM_STATUS_COLORS[item.status]}>
                {PLAN_ITEM_STATUS_LABELS[item.status]}
              </Badge>
              <Badge variant="outline">
                {item.projectScope === 'personal' ? 'Personal' : 'Work'}
              </Badge>
            </div>

            <div className="space-y-1 text-sm">
              <div className="text-xs text-muted-foreground">Owning period</div>
              <div>
                {period
                  ? `${period.scope === 'week' ? 'Week' : 'Month'} · ${period.periodStart} – ${period.periodEnd}`
                  : '—'}
              </div>
            </div>

            {item.deferralChain.length > 1 && (
              <div className="space-y-1 text-sm">
                <div className="text-xs text-muted-foreground">Deferral chain</div>
                <div>{item.deferralChain.map((id) => `%${id}`).join(' → ')}</div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                disabled={!period}
                onClick={() => period && onGoToPlans(period.scope, period.periodStart)}
              >
                前往 /plans
              </Button>
            </div>
          </div>
        )}

        {notFound && (
          <div className="text-sm text-muted-foreground py-4">
            条目不存在。计划条目 %{itemId} 已被删除或从未存在（悬挂引用）。
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
