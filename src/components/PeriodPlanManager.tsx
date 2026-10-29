'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useCallback, useEffect, useState } from 'react'
import {
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
} from 'date-fns'
import { ChevronLeft, ChevronRight, Plus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { PeriodPlanItemRow, type PlanItemRowData } from './PeriodPlanItemRow'
import { getWeekPeriodRange, getMonthPeriodRange } from '@/lib/periods'
import type { PeriodPlan, PeriodPlanItem, PeriodPlanScope } from '@/lib/db/schema'

type PlanResponse = {
  plan: PeriodPlan | null
  items: PlanItemRowData[]
}

type PeriodParams = Record<string, string>

type Props = {
  initialScope?: PeriodPlanScope
  initialStart?: string | null
}

// The deep-link start is a yyyy-MM-dd period start; parse it as a local date.
function parsePeriodStart(start: string | null | undefined): Date | null {
  if (!start) return null
  const date = new Date(`${start}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function PeriodPlanManager({ initialScope = 'week', initialStart = null }: Props = {}) {
  const [scope, setScope] = useState<PeriodPlanScope>(initialScope)
  const [currentDate, setCurrentDate] = useState<Date>(() => parsePeriodStart(initialStart) ?? new Date())
  const [items, setItems] = useState<PeriodPlanItem[]>([])
  const [parentOptions, setParentOptions] = useState<PeriodPlanItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newItemText, setNewItemText] = useState('')

  // Derive the period parameters used by both the read and write endpoints.
  const getPeriodParams = useCallback((): PeriodParams => {
    if (scope === 'week') {
      const range = getWeekPeriodRange(currentDate)
      return {
        scope: 'week',
        weekStart: range.start,
        weekEnd: range.end,
      }
    }
    return {
      scope: 'month',
      month: getMonthPeriodRange(currentDate).monthKey,
    }
  }, [scope, currentDate])

  const fetchPlan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams(getPeriodParams()).toString()
      const response = await apiFetch(`/api/plans?${query}`)
      if (!response.ok) throw new Error('Failed to load plan' + traceSuffix(response))
      const data: PlanResponse = await response.json()
      setItems(data.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plan')
    } finally {
      setLoading(false)
    }
  }, [getPeriodParams])

  useEffect(() => {
    const loadPlan = async () => {
      await fetchPlan()
    }
    void loadPlan()
  }, [fetchPlan])

  // In week scope, offer month items as parent candidates. The parent month is
  // the calendar month that contains the week's start day.
  useEffect(() => {
    if (scope !== 'week') return
    const controller = new AbortController()
    const month = getWeekPeriodRange(currentDate).start.slice(0, 7)
    void apiFetch(`/api/plans?scope=month&month=${month}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load parent options')
        const data: PlanResponse = await response.json()
        if (!controller.signal.aborted) setParentOptions(data.items)
      })
      .catch(() => {
        if (!controller.signal.aborted) setParentOptions([])
      })
    return () => controller.abort()
  }, [scope, currentDate])

  const handleAddItem = async () => {
    const text = newItemText.trim()
    if (!text) return
    try {
      const response = await apiFetch('/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...getPeriodParams(), text, projectScope: 'work' }),
      })
      if (!response.ok) throw new Error('Failed to add item' + traceSuffix(response))
      setNewItemText('')
      // Refetch so the auto-ensured period row and ordering stay consistent.
      await fetchPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item')
    }
  }

  const handleUpdateItem = async (id: number, updates: Partial<PeriodPlanItem>) => {
    try {
      const response = await apiFetch(`/api/plan-items/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error('Failed to update item' + traceSuffix(response))
      const updated: PeriodPlanItem = await response.json()
      setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item')
    }
  }

  const handleDeleteItem = async (id: number) => {
    try {
      const response = await apiFetch(`/api/plan-items/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Failed to delete item' + traceSuffix(response))
      // DELETE returns 200 JSON {deleted: true} (no longer 204). Referrer
      // warnings are surfaced pre-deletion via the confirm dialog's GET.
      const data: { deleted?: boolean } = await response.json()
      if (data.deleted === false) throw new Error('Failed to delete item' + traceSuffix(response))
      setItems((prev) => prev.filter((item) => item.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item')
    }
  }

  const handleDeferItem = async (id: number) => {
    try {
      const response = await apiFetch(`/api/plan-items/${id}/defer`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to defer item' + traceSuffix(response))
      await fetchPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to defer item')
    }
  }

  // Swap positions with the adjacent item to change manual ordering.
  const handleMoveItem = async (id: number, direction: 'up' | 'down') => {
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return
    const swapIndex = direction === 'up' ? index - 1 : index + 1
    if (swapIndex < 0 || swapIndex >= items.length) return
    const current = items[index]
    const neighbour = items[swapIndex]
    await Promise.all([
      apiFetch(`/api/plan-items/${current.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: neighbour.position }),
      }),
      apiFetch(`/api/plan-items/${neighbour.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: current.position }),
      }),
    ])
    await fetchPlan()
  }

  const handlePrevPeriod = () => {
    setCurrentDate((date) => (scope === 'week' ? subWeeks(date, 1) : subMonths(date, 1)))
  }

  const handleNextPeriod = () => {
    setCurrentDate((date) => (scope === 'week' ? addWeeks(date, 1) : addMonths(date, 1)))
  }

  const completedCount = items.filter((item) => item.status === 'done').length
  const totalCount = items.length

  const getPeriodDisplay = () => {
    if (scope === 'week') {
      const range = getWeekPeriodRange(currentDate)
      return `${range.start} - ${range.end}`
    }
    return getMonthPeriodRange(currentDate).monthKey
  }

  return (
    <div className="space-y-6">
      <Tabs value={scope} onValueChange={(value) => setScope(value as PeriodPlanScope)}>
        <TabsList className="w-full">
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="month">Month</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex items-center justify-between gap-4">
        <Button variant="outline" size="icon" onClick={handlePrevPeriod} aria-label="Previous period">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-center text-lg font-medium">{getPeriodDisplay()}</div>
        <Button variant="outline" size="icon" onClick={handleNextPeriod} aria-label="Next period">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {totalCount > 0 && (
        <div className="text-sm text-muted-foreground">
          {completedCount} of {totalCount} completed
        </div>
      )}

      {loading ? (
        <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      ) : error ? (
        <div role="alert" className="py-3 text-sm text-destructive">
          {error}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">No plans yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add your first {scope === 'week' ? 'weekly' : 'monthly'} plan item below.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <PeriodPlanItemRow
              key={item.id}
              item={item}
              parentOptions={scope === 'week' ? parentOptions : []}
              showParentSelector={scope === 'week'}
              canMoveUp={index > 0}
              canMoveDown={index < items.length - 1}
              onUpdate={handleUpdateItem}
              onDelete={handleDeleteItem}
              onDefer={handleDeferItem}
              onMove={handleMoveItem}
            />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={newItemText}
          onChange={(event) => setNewItemText(event.target.value)}
          placeholder="Add a new plan item..."
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleAddItem()
          }}
        />
        <Button onClick={() => void handleAddItem()} disabled={!newItemText.trim()}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>
    </div>
  )
}
