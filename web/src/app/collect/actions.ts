// SPA counterpart of the `'use server'` collect actions (src/app/collect/actions.ts).
//
// In the browser there is no filesystem or SQLite, so the two actions become
// the B4 additive routes (docs/migration-blueprint.md §5 B4): same exported
// names, same argument shapes, same "200 + embedded `error` field" result
// shape. The call sites in ScanReposDialog are deliberately untouched — #115
// inlines these two calls as direct route requests and retires this module.
import { apiFetch, traceSuffix } from '@/lib/api-client'

interface FoundRepo {
  path: string
  name: string
  alreadyAdded: boolean
}

interface AddSourceInput {
  path: string
  name: string
  authorEmails: string[]
}

/**
 * POST a JSON body and return the parsed business result.
 *
 * The routes answer 200 with an embedded `error` field even for business
 * failures, so a non-2xx here means the transport failed (withAuth/audit or a
 * gateway) — that throws, exactly like a server action call that never landed.
 */
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}${traceSuffix(response)}`)
  }
  return (await response.json()) as T
}

export async function scanRepos(
  basePath: string,
  maxDepth: number = 3,
): Promise<{ repos: FoundRepo[]; error?: string }> {
  return postJSON('/api/collect/scan-repos', { basePath, maxDepth })
}

export async function batchAddSources(
  repos: AddSourceInput[],
): Promise<{ success: boolean; addedCount: number; error?: string }> {
  return postJSON('/api/collect/batch-add-sources', { repos })
}
