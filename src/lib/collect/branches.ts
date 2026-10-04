import type { CollectSourceConfig } from '@/lib/db/schema'

export type BranchConfigValue = NonNullable<CollectSourceConfig['branches']>[number]
export type NormalizedBranch = { name: string; lastCommitTime: string | null }

/** Normalize edited branch names while preserving cursors by exact name. */
export function mergeEditedBranches(
  existing: CollectSourceConfig['branches'] | undefined,
  edited: BranchConfigValue[] | undefined,
): NormalizedBranch[] | undefined {
  if (!edited || edited.length === 0) return undefined

  const cursorByName = new Map<string, string | null>()
  for (const branch of existing || []) {
    const name = typeof branch === 'string' ? branch.trim() : branch.name.trim()
    if (!name || cursorByName.has(name)) continue
    cursorByName.set(name, typeof branch === 'string' ? null : branch.lastCommitTime || null)
  }

  const result: NormalizedBranch[] = []
  for (const branch of edited) {
    const name = (typeof branch === 'string' ? branch : branch.name).trim()
    if (!name || result.some(item => item.name === name)) continue
    result.push({ name, lastCommitTime: cursorByName.get(name) || null })
  }
  return result.length > 0 ? result : undefined
}

/** True when the branch config is missing, empty, or every entry is blank. */
export function isEmptyBranchConfig(branches: CollectSourceConfig['branches']): boolean {
  if (!branches) return true
  if (!Array.isArray(branches) || branches.length === 0) return true
  return branches.every(b => {
    const name = typeof b === 'string' ? b : b.name
    return typeof name !== 'string' || name.trim() === ''
  })
}

/**
 * Order branches for attribution: current branch first (only when present in
 * localHeads), then the rest ascending, no duplicates.
 */
export function orderBranchesForAttribution(
  localHeads: string[],
  currentBranch: string,
): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  if (currentBranch && localHeads.includes(currentBranch)) {
    ordered.push(currentBranch)
    seen.add(currentBranch)
  }

  const rest = [...localHeads].sort((a, b) => a.localeCompare(b))
  for (const name of rest) {
    if (seen.has(name)) continue
    ordered.push(name)
    seen.add(name)
  }
  return ordered
}

/**
 * Build per-branch cursors for the current set of local heads, pruning any
 * cursor whose branch no longer exists.
 */
export function buildPrunedBranchCursors(
  localHeads: string[],
  maxByBranch: Record<string, Date>,
  existingCursors: Array<{ name: string; lastCommitTime: string | null }>,
): Array<{ name: string; lastCommitTime: string | null }> {
  const existingByName = new Map<string, string | null>()
  for (const cursor of existingCursors) {
    if (!existingByName.has(cursor.name)) {
      existingByName.set(cursor.name, cursor.lastCommitTime ?? null)
    }
  }

  return localHeads.map(name => ({
    name,
    lastCommitTime: maxByBranch[name]?.toISOString() ?? existingByName.get(name) ?? null,
  }))
}
