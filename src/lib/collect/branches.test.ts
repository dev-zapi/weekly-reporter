import { describe, expect, it } from 'vitest'
import { mergeEditedBranches, isEmptyBranchConfig, orderBranchesForAttribution, buildPrunedBranchCursors } from './branches'

describe('mergeEditedBranches', () => {
  it('preserves cursors for exact names and resets renamed branches', () => {
    const result = mergeEditedBranches(
      [{ name: 'main', lastCommitTime: '2026-08-24T10:00:00.000Z' }, 'develop'],
      [{ name: 'main' }, { name: 'release' }],
    )

    expect(result).toEqual([
      { name: 'main', lastCommitTime: '2026-08-24T10:00:00.000Z' },
      { name: 'release', lastCommitTime: null },
    ])
  })

  it('trims names, removes empty entries and deduplicates exact names', () => {
    expect(mergeEditedBranches(undefined, [{ name: ' main ' }, { name: '' }, 'main'])).toEqual([
      { name: 'main', lastCommitTime: null },
    ])
  })

  it('returns undefined for an empty configuration', () => {
    expect(mergeEditedBranches([{ name: 'main', lastCommitTime: '2026-08-24T10:00:00.000Z' }], [])).toBeUndefined()
  })
})

describe('isEmptyBranchConfig', () => {
  it('returns true for undefined', () => {
    expect(isEmptyBranchConfig(undefined)).toBe(true)
  })

  it('returns true for empty array', () => {
    expect(isEmptyBranchConfig([])).toBe(true)
  })

  it('returns true when every entry is blank', () => {
    expect(isEmptyBranchConfig([{ name: '' }])).toBe(true)
    expect(isEmptyBranchConfig([{ name: '  ' }, { name: '' }])).toBe(true)
  })

  it('returns false for a non-empty branch config (string form)', () => {
    expect(isEmptyBranchConfig(['main'])).toBe(false)
  })

  it('returns false for a non-empty branch config (object form)', () => {
    expect(isEmptyBranchConfig([{ name: 'main' }])).toBe(false)
  })
})

describe('orderBranchesForAttribution', () => {
  it('puts current branch first when present in heads', () => {
    expect(orderBranchesForAttribution(['develop', 'main', 'release'], 'main')).toEqual([
      'main', 'develop', 'release',
    ])
  })

  it('omits current branch when not in heads (e.g. detached HEAD)', () => {
    expect(orderBranchesForAttribution(['develop', 'release'], '')).toEqual([
      'develop', 'release',
    ])
  })

  it('returns ascending order when current is absent from heads', () => {
    expect(orderBranchesForAttribution(['develop', 'release'], 'feature')).toEqual([
      'develop', 'release',
    ])
  })

  it('returns ascending order for empty current', () => {
    expect(orderBranchesForAttribution(['b', 'a', 'c'], '')).toEqual(['a', 'b', 'c'])
  })

  it('does not duplicate the current branch', () => {
    const result = orderBranchesForAttribution(['main', 'develop'], 'main')
    expect(result.filter(n => n === 'main')).toHaveLength(1)
  })
})

describe('buildPrunedBranchCursors', () => {
  it('prunes deleted branches', () => {
    const result = buildPrunedBranchCursors(
      ['main', 'develop'],
      {},
      [
        { name: 'main', lastCommitTime: '2026-01-01T00:00:00.000Z' },
        { name: 'old-branch', lastCommitTime: '2025-12-01T00:00:00.000Z' },
      ],
    )
    expect(result).toEqual([
      { name: 'main', lastCommitTime: '2026-01-01T00:00:00.000Z' },
      { name: 'develop', lastCommitTime: null },
    ])
  })

  it('keeps existing cursor when no new commits', () => {
    const result = buildPrunedBranchCursors(
      ['main'],
      {},
      [{ name: 'main', lastCommitTime: '2026-01-01T00:00:00.000Z' }],
    )
    expect(result).toEqual([
      { name: 'main', lastCommitTime: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('uses new max when present', () => {
    const newMax = new Date('2026-06-01T00:00:00.000Z')
    const result = buildPrunedBranchCursors(
      ['main'],
      { main: newMax },
      [{ name: 'main', lastCommitTime: '2026-01-01T00:00:00.000Z' }],
    )
    expect(result).toEqual([
      { name: 'main', lastCommitTime: '2026-06-01T00:00:00.000Z' },
    ])
  })
})
