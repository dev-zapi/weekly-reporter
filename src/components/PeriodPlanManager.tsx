'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  format,
  startOfWeek,
  endOfWeek,
  startOfMonth,
} from 'date-fns'
import { ChevronLeft, ChevronRight, Plus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { PeriodPlanItemRow } from './PeriodPlanItemRow'
import type { PeriodPlan, PeriodPlanItem } from '@/lib/db/schema'

type Scope = 'week' | 'month'

type PlanResponse = {
  plan: PeriodPlan | null
  items: PeriodPlanItem[]
}

type PeriodParams = Record<string, string>

const dateFormat = 'yyyy-MM-dd'

export function PeriodPlanManager() {
  const [scope, setScope] = useState<Scope>('week')
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date())
  const [items, setItems] = useState<PeriodPlanItem[]>([])
  const [parentOptions, setParentOptions] = useState<PeriodPlanItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newItemText, setNewItemText] = useState('')

  // Derive the period parameters used by both the read and write endpoints.
  const getPeriodParams = useCallback((): PeriodParams => {
    if (scope === 'week') {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 })
      const end = endOfWeek(currentDate, { weekStartsOn: 1 })
      return {
        scope: 'week',
        weekStart: format(start, dateFormat),
        weekEnd: format(end, dateFormat),
      }
    }
    return {
      scope: 'month',
      month: format(startOfMonth(currentDate), 'yyyy-MM'),
    }
  }, [scope, currentDate])

  const fetchPlan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams(getPeriodParams()).toString()
      const response = await fetch(`/api/plans?${query}`)
      if (!response.ok) throw new Error('Failed to load plan')
      const data: PlanResponse = await response.json()
      setItems(data.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plan')
    } finally {
      setLoading(false)
    }
  }, [getPeriodParams])

  useEffect(() => {
    void fetchPlan()
  }, [fetchPlan])

  // In week scope, offer month items as parent candidates. The parent month is
  // the calendar month that contains the week's start day.
  useEffect(() => {
    if (scope !== 'week') {
      setParentOptions([])
      return
    }
    const controller = new AbortController()
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 })
    const month = format(weekStart, 'yyyy-MM')
    void fetch(`/api/plans?scope=month&month=${month}`, { signal: controller.signal })
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
      const response = await fetch('/api/plan-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...getPeriodParams(), text, projectScope: 'work' }),
      })
      if (!response.ok) throw new Error('Failed to add item')
      setNewItemText('')
      // Refetch so the auto-ensured period row and ordering stay consistent.
      await fetchPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item')
    }
  }

  const handleUpdateItem = async (id: number, updates: Partial<PeriodPlanItem>) => {
    try {
      const response = await fetch(`/api/plan-items/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error('Failed to update item')
      const updated: PeriodPlanItem = await response.json()
      setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item')
    }
  }

  const handleDeleteItem = async (id: number) => {
    try {
      const response = await fetch(`/api/plan-items/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Failed to delete item')
      setItems((prev) => prev.filter((item) => item.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item')
    }
  }

  const handleDeferItem = async (id: number) => {
    try {
      const response = await fetch(`/api/plan-items/${id}/defer`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to defer item')
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
      fetch(`/api/plan-items/${current.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: neighbour.position }),
      }),
      fetch(`/api/plan-items/${neighbour.id}`, {
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
      const start = startOfWeek(currentDate, { weekStartsOn: 1 })
      const end = endOfWeek(currentDate, { weekStartsOn: 1 })
      return `${format(start, dateFormat)} - ${format(end, dateFormat)}`
    }
    return format(currentDate, 'yyyy-MM')
  }

  return (
    <div className="space-y-6">
      <Tabs value={scope} onValueChange={(value) => setScope(value as Scope)}>
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
