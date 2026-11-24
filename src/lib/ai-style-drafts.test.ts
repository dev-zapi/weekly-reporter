import { beforeEach, describe, expect, it } from 'vitest'
import {
  aiStyleDraftKey,
  clearAIStyleDraft,
  emptyStyleForm,
  parseAIStyleDraft,
  readAIStyleDraft,
  writeAIStyleDraft,
} from './ai-style-drafts'

describe('AI style local drafts', () => {
  beforeEach(() => window.localStorage.clear())

  it('uses separate keys for new and each edited style', () => {
    expect(aiStyleDraftKey('new')).toBe('weekly-reporter.ai-style-draft.new')
    expect(aiStyleDraftKey('edit', 3)).toBe('weekly-reporter.ai-style-draft.edit.3')
    expect(aiStyleDraftKey('edit', 4)).not.toBe(aiStyleDraftKey('edit', 3))
  })

  it('round-trips complete multiline form state and clears it explicitly', () => {
    const key = aiStyleDraftKey('edit', 8)
    const form = {
      ...emptyStyleForm('technical'),
      label: '技术研发',
      systemPrompt: '第一行\n\n第二行 # 保留原文',
      temperature: 1.4,
      detailLevel: 'high',
      resultOriented: 'low',
      isDefault: true,
    }

    expect(writeAIStyleDraft(key, form)).toBe(true)
    expect(readAIStyleDraft(key)).toEqual(form)
    clearAIStyleDraft(key)
    expect(readAIStyleDraft(key)).toBeNull()
  })

  it('rejects malformed, outdated and structurally invalid drafts', () => {
    expect(parseAIStyleDraft('{')).toBeNull()
    expect(parseAIStyleDraft(JSON.stringify({ version: 2, form: emptyStyleForm() }))).toBeNull()
    expect(parseAIStyleDraft(JSON.stringify({ version: 1, form: { key: 'missing-fields' } }))).toBeNull()
    expect(parseAIStyleDraft(JSON.stringify({
      version: 1,
      form: { ...emptyStyleForm(), temperature: 3 },
    }))).toBeNull()
  })

  it('keeps invalid in-progress keys and empty required fields recoverable', () => {
    const form = { ...emptyStyleForm('NOT-YET-VALID'), label: '', systemPrompt: '' }
    expect(parseAIStyleDraft(JSON.stringify({ version: 1, form }))).toEqual(form)
  })

  it('treats unavailable storage as an empty, non-blocking draft store', () => {
    expect(readAIStyleDraft('key', null)).toBeNull()
    expect(writeAIStyleDraft('key', emptyStyleForm(), null)).toBe(false)
    expect(() => clearAIStyleDraft('key', null)).not.toThrow()
  })
})
