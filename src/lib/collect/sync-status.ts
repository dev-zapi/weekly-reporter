/**
 * `last_sync_status` is written as `failed` by the collector
 * (`src/lib/collect/sync.ts`), while the collect API, the collection-sources
 * UI, and the skill CLIs have historically used `failure` as the filter value.
 * Both spellings describe the same stored state, so every read path accepts
 * either one.
 */
export const SYNC_FAILED_STATUSES = ['failed', 'failure'] as const

export function isSyncFailure(status: string | null | undefined): boolean {
  return status === 'failed' || status === 'failure'
}
