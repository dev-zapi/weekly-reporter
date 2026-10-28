import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { proposeFinalReportInputSchema } from './generation-tools'

describe('proposeFinalReportInputSchema', () => {
  const minimalValid = { content: 'x', summary: ['s'] }

  it('renders canonical visible schema (no anyOf/oneOf leak)', () => {
    const json = z.toJSONSchema(proposeFinalReportInputSchema) as {
      properties: Record<string, unknown>
    }
    expect(json.properties.summary).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: '面向用户的简短变更摘要',
    })
    const publicSummary = json.properties.publicSummary as {
      type?: string
      properties?: Record<string, unknown>
      anyOf?: unknown
      oneOf?: unknown
    }
    expect(publicSummary.anyOf).toBeUndefined()
    expect(publicSummary.oneOf).toBeUndefined()
    expect(publicSummary.type).toBe('object')
    expect(publicSummary.properties).toEqual({
      modelHandling: { type: 'array', items: { type: 'string' }, description: '模型显式提供的简短处理说明；不得复制历史正文或推测隐藏推理' },
    })
  })

  it('coerces a bare string summary into [string]', () => {
    const result = proposeFinalReportInputSchema.parse({ content: 'x', summary: 'hello' })
    expect(result.summary).toEqual(['hello'])
  })

  it('leaves an array summary unchanged', () => {
    const result = proposeFinalReportInputSchema.parse({ content: 'x', summary: ['a', 'b'] })
    expect(result.summary).toEqual(['a', 'b'])
  })

  it('coerces a bare string[] publicSummary into { modelHandling: [...] }', () => {
    const result = proposeFinalReportInputSchema.parse({
      content: 'x',
      summary: ['s'],
      publicSummary: ['x'],
    })
    expect(result.publicSummary).toEqual({ modelHandling: ['x'] })
  })

  it('passes through a structured publicSummary unchanged', () => {
    const input = { content: 'x', summary: ['s'], publicSummary: { modelHandling: ['y'] } }
    const result = proposeFinalReportInputSchema.parse(input)
    expect(result.publicSummary).toEqual({ modelHandling: ['y'] })
  })

  it('rejects legacy planJudgments (deleted + strictObject)', () => {
    const r = proposeFinalReportInputSchema.safeParse({
      ...minimalValid,
      planJudgments: [],
    })
    expect(r.success).toBe(false)
  })

  it('rejects legacy planItems (deleted + strictObject)', () => {
    const r = proposeFinalReportInputSchema.safeParse({
      ...minimalValid,
      planItems: [],
    })
    expect(r.success).toBe(false)
  })

  it('rejects the removed plan parameter (strictObject)', () => {
    const r = proposeFinalReportInputSchema.safeParse({
      ...minimalValid,
      plan: { items: [] },
    })
    expect(r.success).toBe(false)
    const json = z.toJSONSchema(proposeFinalReportInputSchema) as {
      properties: Record<string, unknown>
    }
    expect(json.properties.plan).toBeUndefined()
  })

  it('rejects a bare string for publicSummary (narrow-scope guard)', () => {
    const r = proposeFinalReportInputSchema.safeParse({
      content: 'x',
      summary: ['s'],
      publicSummary: 'oops',
    })
    expect(r.success).toBe(false)
  })

  it('requires content', () => {
    const r = proposeFinalReportInputSchema.safeParse({ summary: ['s'] })
    expect(r.success).toBe(false)
  })
})
