import { describe, expect, it } from 'vitest'
import { parseReferences } from './parse'

describe('parseReferences', () => {
  it('extracts a reference surrounded by spaces', () => {
    expect(parseReferences('see @7008 for details')).toEqual([7008])
  })
  it('extracts two adjacent references with single space', () => {
    expect(parseReferences('@100 @200')).toEqual([100, 200])
  })
  it('returns empty for #7008 (tag syntax)', () => {
    expect(parseReferences('#7008')).toEqual([])
  })
  it('handles references on separate lines', () => {
    expect(parseReferences('@100\n@200')).toEqual([100, 200])
  })
  it('rejects a reference preceded by non-whitespace (foo@7008.com)', () => {
    expect(parseReferences('foo@7008.com')).toEqual([])
  })
  it('rejects a reference followed by non-digit (@7008abc)', () => {
    expect(parseReferences('@7008abc')).toEqual([])
  })
  it('matches a reference at end of content (no trailing space)', () => {
    expect(parseReferences('content @7008')).toEqual([7008])
  })
  it('deduplicates repeated references', () => {
    expect(parseReferences('@100 @100')).toEqual([100])
  })
  it('returns empty for content without references', () => {
    expect(parseReferences('just plain text')).toEqual([])
  })
  it('handles leading/trailing newlines', () => {
    expect(parseReferences('\n@100\n')).toEqual([100])
  })
  it('extracts single-digit reference id', () => {
    expect(parseReferences('@1')).toEqual([1])
  })
  it('rejects @0 (id must be positive)', () => {
    expect(parseReferences('@0')).toEqual([])
  })
  it('does not trigger on email-like patterns (user@7008.com)', () => {
    expect(parseReferences('user@7008.com')).toEqual([])
  })
  it('extracts reference at start of content', () => {
    expect(parseReferences('@100 and more')).toEqual([100])
  })
  it('extracts reference as the entire content', () => {
    expect(parseReferences('@100')).toEqual([100])
  })
  it('extracts multiple distinct references from multiline content', () => {
    expect(parseReferences('line1 @100\nline2 @200 @300')).toEqual([100, 200, 300])
  })
  it('rejects reference with leading non-whitespace boundary', () => {
    expect(parseReferences('abc@100')).toEqual([])
  })
  it('extracts reference after tab character', () => {
    expect(parseReferences('text\t@100')).toEqual([100])
  })
})
