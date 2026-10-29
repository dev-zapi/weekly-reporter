import { apiFetch, traceSuffix } from '@/lib/api-client'
import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import type { CollectSource } from '../CollectSourceList'

const PAGE_SIZE = 20

interface Filters {
  searchInput: string
  searchTerm: string
  syncStatusFilter: string
  sourceStatusFilter: string
  typeFilter: string
  scopeFilter: string
  sortBy: string
  sortOrder: string
  setSearchInput: (v: string) => void
  setSearchTerm: (v: string) => void
  setSyncStatusFilter: (v: string) => void
  setSourceStatusFilter: (v: string) => void
  setTypeFilter: (v: string) => void
  setScopeFilter: (v: string) => void
  setSort: (column: string) => void
  setSortBy: (v: string) => void
  setSortOrder: (v: string) => void
}

function sessionGet(key: string, fallback = ''): string {
  if (typeof window !== 'undefined') {
    return sessionStorage.getItem(key) || fallback
  }
  return fallback
}

export function useSourceListQuery(): {
  sources: CollectSource[]
  setSources: (updater: CollectSource[] | ((prev: CollectSource[]) => CollectSource[])) => void
  total: number
  loading: boolean
  page: number
  setPage: (p: number | ((prev: number) => number)) => void
  filters: Filters
  refetch: (targetPage?: number) => Promise<void>
} {
  const [sources, setSources] = useState<CollectSource[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  const [searchInput, setSearchInputRaw] = useState<string>(() => sessionGet('sourceSearch'))
  const [searchTerm, setSearchTerm] = useState<string>(() => sessionGet('sourceSearch'))
  const [syncStatusFilter, setSyncStatusFilterRaw] = useState<string>(() => sessionGet('sourceSyncStatus'))
  const [sourceStatusFilter, setSourceStatusFilterRaw] = useState<string>(() => sessionGet('sourceStatusFilter'))
  const [typeFilter, setTypeFilterRaw] = useState<string>(() => sessionGet('sourceType'))
  const [scopeFilter, setScopeFilterRaw] = useState<string>(() => sessionGet('sourceScope'))
  const [sortBy, setSortByRaw] = useState<string>(() => sessionGet('sourceSortBy'))
  const [sortOrder, setSortOrderRaw] = useState<string>(() => sessionGet('sourceSortOrder', 'desc'))

  const setSearchInput = (v: string) => {
    setSearchInputRaw(v)
    sessionStorage.setItem('sourceSearch', v)
  }
  const setSyncStatusFilter = (v: string) => {
    setSyncStatusFilterRaw(v)
    sessionStorage.setItem('sourceSyncStatus', v)
    setPage(1)
  }
  const setSourceStatusFilter = (v: string) => {
    setSourceStatusFilterRaw(v)
    sessionStorage.setItem('sourceStatusFilter', v)
    setPage(1)
  }
  const setTypeFilter = (v: string) => {
    setTypeFilterRaw(v)
    sessionStorage.setItem('sourceType', v)
    setPage(1)
  }
  const setScopeFilter = (v: string) => {
    setScopeFilterRaw(v)
    sessionStorage.setItem('sourceScope', v)
    setPage(1)
  }
  const setSortBy = (v: string) => {
    setSortByRaw(v)
    sessionStorage.setItem('sourceSortBy', v)
    setPage(1)
  }
  const setSortOrder = (v: string) => {
    setSortOrderRaw(v)
    sessionStorage.setItem('sourceSortOrder', v)
  }
  const setSort = (column: string) => {
    let newSortBy: string
    let newSortOrder: string
    if (sortBy === column) {
      if (sortOrder === 'asc') {
        newSortBy = column
        newSortOrder = 'desc'
      } else {
        newSortBy = ''
        newSortOrder = 'desc'
      }
    } else {
      newSortBy = column
      newSortOrder = 'asc'
    }
    setSortBy(newSortBy)
    setSortOrder(newSortOrder)
  }

  // Debounce searchInput -> searchTerm
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchInput.trim()
      setSearchTerm(trimmed)
      sessionStorage.setItem('sourceSearch', trimmed)
      setPage(prev => prev !== 1 ? 1 : prev)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const fetchSources = useCallback(async (targetPage?: number) => {
    const p = targetPage ?? page
    try {
      setLoading(true)
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (searchTerm) params.set('name', searchTerm)
      if (typeFilter) params.set('type', typeFilter)
      if (syncStatusFilter) params.set('syncStatus', syncStatusFilter)
      if (sourceStatusFilter) params.set('sourceStatus', sourceStatusFilter)
      if (scopeFilter) params.set('projectScope', scopeFilter)
      if (sortBy) {
        params.set('sortBy', sortBy)
        params.set('sortOrder', sortOrder)
      }
      const res = await apiFetch(`/api/collect/sources?${params}`)

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error((errorData.error || `HTTP ${res.status}`) + traceSuffix(res))
      }

      const data = await res.json()
      setSources(data.sources || [])
      setTotal(data.total || 0)
    } catch (error) {
      console.error('Failed to fetch sources:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load sources')
    } finally {
      setLoading(false)
    }
  }, [page, searchTerm, syncStatusFilter, sourceStatusFilter, typeFilter, scopeFilter, sortBy, sortOrder])

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  const filters: Filters = {
    searchInput,
    searchTerm,
    syncStatusFilter,
    sourceStatusFilter,
    typeFilter,
    scopeFilter,
    sortBy,
    sortOrder,
    setSearchInput,
    setSearchTerm,
    setSyncStatusFilter,
    setSourceStatusFilter,
    setTypeFilter,
    setScopeFilter,
    setSort,
    setSortBy,
    setSortOrder,
  }

  return {
    sources,
    setSources,
    total,
    loading,
    page,
    setPage,
    filters,
    refetch: fetchSources,
  }
}
