'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import type { AIStyleRow } from '@/lib/db/schema'

export interface StyleFormData {
  key: string
  label: string
  systemPrompt: string
  temperature: number
  detailLevel: string
  resultOriented: string
  isDefault: boolean
}

async function tryGetError(res: Response): Promise<string> {
  try {
    const err = await res.json()
    return err.error || 'Operation failed'
  } catch {
    return 'Operation failed'
  }
}

export function useAIStyles() {
  const [styles, setStyles] = useState<AIStyleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/prompts/styles')
      if (!res.ok) throw new Error('Failed to load styles')
      const data = await res.json()
      setStyles(data.styles || [])
      setError(null)
    } catch {
      setError('AI styles could not be loaded. Retry to refresh the style index.')
      toast.error('Failed to load styles')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const res = await apiFetch('/api/prompts/styles')
        if (!res.ok) throw new Error('Failed to load styles')
        const data = await res.json()
        if (!cancelled) setStyles(data.styles || [])
      } catch {
        if (cancelled) return
        setError('AI styles could not be loaded. Retry to refresh the style index.')
        toast.error('Failed to load styles')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const retry = useCallback(async () => {
    setLoading(true)
    setError(null)
    await refresh()
  }, [refresh])

  const create = useCallback(async (payload: StyleFormData): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/prompts/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        toast.success('Style created')
        await refresh()
        return true
      }
      toast.error(await tryGetError(res) || 'Creation failed')
      return false
    } catch {
      toast.error('Operation failed')
      return false
    }
  }, [refresh])

  const update = useCallback(async (id: number, payload: StyleFormData): Promise<boolean> => {
    try {
      const res = await apiFetch(`/api/prompts/styles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        toast.success('Style updated')
        await refresh()
        return true
      }
      toast.error(await tryGetError(res) || 'Update failed')
      return false
    } catch {
      toast.error('Operation failed')
      return false
    }
  }, [refresh])

  const remove = useCallback(async (id: number): Promise<boolean> => {
    try {
      const res = await apiFetch(`/api/prompts/styles/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success('Style deleted')
        await refresh()
        return true
      }
      toast.error(await tryGetError(res) || 'Delete failed')
      return false
    } catch {
      toast.error('Delete failed')
      return false
    }
  }, [refresh])

  const setDefault = useCallback(async (id: number): Promise<boolean> => {
    try {
      const res = await apiFetch(`/api/prompts/styles/${id}`, { method: 'PATCH' })
      if (res.ok) {
        // Find the label before refresh mutates state; refresh then toast.
        const targetLabel = styles.find((s) => s.id === id)?.label ?? ''
        await refresh()
        toast.success(`"${targetLabel}" is now the default style`)
        return true
      }
      toast.error(await tryGetError(res) || 'Update failed')
      return false
    } catch {
      toast.error('Update failed')
      return false
    }
  }, [refresh, styles])

  return {
    styles,
    loading,
    error,
    refresh,
    retry,
    create,
    update,
    remove,
    setDefault,
  }
}
