import { describe, expect, it } from 'vitest'
import { parsePlanReferences } from './parse'

describe('parsePlanReferences', () => {
  it('extracts a plan reference surrounded by spaces', () => {
    expect(parsePlanReferences('see %42 for details')).toEqual([42])
  })
  it('extracts two adjacent references with single space', () => {
    expect(parsePlanReferences('%100 %200')).toEqual([100, 200])
  })
  it('returns empty for #42 (tag syntax)', () => {
    expect(parsePlanReferences('#42')).toEqual([])
  })
  it('returns empty for @42 (reference syntax)', () => {
    expect(parsePlanReferences('@42')).toEqual([])
  })
  it('handles references on separate lines', () => {
    expect(parsePlanReferences('%100\n%200')).toEqual([100, 200])
  })
  it('rejects a reference preceded by non-whitespace (50%42)', () => {
    expect(parsePlanReferences('50%42')).toEqual([])
  })
  it('rejects a reference followed by non-digit (%42abc)', () => {
    expect(parsePlanReferences('%42abc')).toEqual([])
  })
  it('matches a reference at end of content (no trailing space)', () => {
    expect(parsePlanReferences('content %42')).toEqual([42])
  })
  it('deduplicates repeated references', () => {
    expect(parsePlanReferences('%100 %100')).toEqual([100])
  })
  it('returns empty for content without references', () => {
    expect(parsePlanReferences('just plain text')).toEqual([])
  })
  it('handles leading/trailing newlines', () => {
    expect(parsePlanReferences('\n%100\n')).toEqual([100])
  })
  it('extracts single-digit reference id', () => {
    expect(parsePlanReferences('%1')).toEqual([1])
  })
  it('rejects %0 (id must be positive)', () => {
    expect(parsePlanReferences('%0')).toEqual([])
  })
  it('extracts reference at start of content', () => {
    expect(parsePlanReferences('%100 and more')).toEqual([100])
  })
  it('extracts reference as the entire content', () => {
    expect(parsePlanReferences('%100')).toEqual([100])
  })
  it('extracts multiple distinct references from multiline content', () => {
    expect(parsePlanReferences('line1 %100\nline2 %200 %300')).toEqual([100, 200, 300])
  })
  it('rejects reference with leading non-whitespace boundary', () => {
    expect(parsePlanReferences('abc%100')).toEqual([])
  })
  it('extracts reference after tab character', () => {
    expect(parsePlanReferences('text\t%100')).toEqual([100])
  })
})
