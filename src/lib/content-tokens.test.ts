import { describe, expect, it } from 'vitest'
import { segmentContentTokens } from './content-tokens'

describe('segmentContentTokens', () => {
  it('returns a single text token for plain content', () => {
    expect(segmentContentTokens('just plain text')).toEqual([
      { type: 'text', text: 'just plain text' },
    ])
  })

  it('returns no tokens for empty content', () => {
    expect(segmentContentTokens('')).toEqual([])
  })

  it('segments an event reference surrounded by text', () => {
    expect(segmentContentTokens('see @7008 for details')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'event-reference', id: 7008 },
      { type: 'text', text: ' for details' },
    ])
  })

  it('segments a plan reference surrounded by text', () => {
    expect(segmentContentTokens('did %42 today')).toEqual([
      { type: 'text', text: 'did ' },
      { type: 'plan-reference', id: 42 },
      { type: 'text', text: ' today' },
    ])
  })

  it('recognizes both token kinds in one string, preserving order', () => {
    expect(segmentContentTokens('%1 then @2')).toEqual([
      { type: 'plan-reference', id: 1 },
      { type: 'text', text: ' then ' },
      { type: 'event-reference', id: 2 },
    ])
  })

  it('keeps separating whitespace between adjacent tokens', () => {
    expect(segmentContentTokens('@100 %200')).toEqual([
      { type: 'event-reference', id: 100 },
      { type: 'text', text: ' ' },
      { type: 'plan-reference', id: 200 },
    ])
  })

  it('preserves multiple spaces between adjacent tokens', () => {
    expect(segmentContentTokens('%1  @2')).toEqual([
      { type: 'plan-reference', id: 1 },
      { type: 'text', text: '  ' },
      { type: 'event-reference', id: 2 },
    ])
  })

  it('treats non-positive ids as plain text', () => {
    expect(segmentContentTokens('%0 @0')).toEqual([{ type: 'text', text: '%0 @0' }])
  })

  it('rejects a token preceded by non-whitespace (50%42)', () => {
    expect(segmentContentTokens('50%42')).toEqual([{ type: 'text', text: '50%42' }])
  })

  it('rejects a token followed by non-digit (%42abc)', () => {
    expect(segmentContentTokens('%42abc')).toEqual([{ type: 'text', text: '%42abc' }])
  })

  it('handles tokens across lines', () => {
    expect(segmentContentTokens('a @1\nb %2')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'event-reference', id: 1 },
      { type: 'text', text: '\nb ' },
      { type: 'plan-reference', id: 2 },
    ])
  })

  it('keeps repeated occurrences of the same id (rendering, not indexing)', () => {
    expect(segmentContentTokens('%5 and %5')).toEqual([
      { type: 'plan-reference', id: 5 },
      { type: 'text', text: ' and ' },
      { type: 'plan-reference', id: 5 },
    ])
  })

  it('handles a token at the very start of content', () => {
    expect(segmentContentTokens('%9 done')).toEqual([
      { type: 'plan-reference', id: 9 },
      { type: 'text', text: ' done' },
    ])
  })
})
