/**
 * Thin, result-returning wrappers around the collect-source API endpoints.
 *
 * Each function performs the fetch with the same endpoint/method/body as the
 * inline handlers in `CollectSourceList.tsx`, parses the response, and returns
 * a typed result. No toast, no React state — UI concerns stay in the caller.
 *
 * All requests go through `apiFetch` so they carry the Bearer token and get
 * the standard 401 handling (clear credentials, redirect to /login).
 */

export interface SyncSourceResult {
  ok: boolean
  eventsCount?: number
  warnings?: string[]
  autoDisabled?: boolean
  error?: string
}

export interface SimpleResult {
  ok: boolean
  error?: string
}

export interface BulkUpdateScopeResult {
  ok: boolean
  updatedCount?: number
  error?: string
}

export interface BulkDeleteResult {
  ok: boolean
  deletedCount?: number
  error?: string
}

import { apiFetch, traceSuffix } from '../api-client'

export async function syncSource(
  sourceId: number,
  opts?: { resync?: boolean },
): Promise<SyncSourceResult> {
  const res = await apiFetch('/api/collect/git-remote/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts?.resync ? { sourceId, resync: true } : { sourceId }),
  })
  const data = await res.json()
  if (data.result?.status === 'success') {
    return {
      ok: true,
      eventsCount: data.result.eventsCount,
      warnings: data.result.warnings,
    }
  }
  if (data.result?.autoDisabled) {
    return { ok: false, autoDisabled: true }
  }
  return { ok: false, error: data.error ? data.error + traceSuffix(res) : data.error }
}

export async function fetchRepo(sourceId: number): Promise<SimpleResult> {
  const res = await apiFetch('/api/collect/git-local/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId }),
  })
  const data = await res.json()
  if (res.ok && data.result?.status === 'success') {
    return { ok: true }
  }
  return { ok: false, error: data.error ? data.error + traceSuffix(res) : data.error }
}

export async function toggleSource(
  sourceId: number,
  newStatus: string,
): Promise<SimpleResult> {
  const res = await apiFetch(`/api/collect/sources/${sourceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Unknown error' }))
    return { ok: false, error: data.error ? data.error + traceSuffix(res) : data.error }
  }
  return { ok: true }
}

export async function deleteSource(sourceId: number): Promise<SimpleResult> {
  const res = await apiFetch(`/api/collect/sources/${sourceId}`, {
    method: 'DELETE',
  })
  const data = await res.json()
  if (data.success) {
    return { ok: true }
  }
  return { ok: false, error: data.error ? data.error + traceSuffix(res) : data.error }
}

export async function bulkUpdateScope(
  ids: number[],
  projectScope: 'work' | 'personal',
): Promise<BulkUpdateScopeResult> {
  const res = await apiFetch('/api/collect/sources/bulk-update-scope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, projectScope }),
  })
  const data = await res.json()
  if (data.success) {
    return { ok: true, updatedCount: data.updatedCount }
  }
  return { ok: false, error: data.error ? data.error + traceSuffix(res) : data.error }
}

export async function bulkDelete(ids: number[]): Promise<BulkDeleteResult> {
  const res = await apiFetch('/api/collect/sources/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  const data = await res.json()
  if (data.success) {
    return { ok: true, deletedCount: data.deletedCount }
  }
  return { ok: false, error: data.error ? data.error + traceSuffix(res) : data.error }
}
