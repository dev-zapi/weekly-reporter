import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findVariant: vi.fn(),
  findReport: vi.fn(),
  findProposal: vi.fn(),
  findSession: vi.fn(),
  findTemplate: vi.fn(),
  findAIStyle: vi.fn(),
  returning: vi.fn(),
  transactionReturning: vi.fn(),
  set: vi.fn(),
  insert: vi.fn(),
  insertRun: vi.fn(),
  select: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    query: {
      reportVariants: { findFirst: mocks.findVariant },
      reports: { findFirst: mocks.findReport },
      generationProposals: { findFirst: mocks.findProposal },
      generationSessions: { findFirst: mocks.findSession },
      templates: { findFirst: mocks.findTemplate },
      aiStyles: { findFirst: mocks.findAIStyle },
    },
    update: () => ({
      set: (values: unknown) => {
        mocks.set(values)
        return {
        where: () => ({ returning: mocks.returning }),
        }
      },
    }),
    insert: () => ({ values: (values: unknown) => {
      mocks.insert(values)
      return { run: mocks.insertRun }
    } }),
    select: mocks.select,
    transaction: (callback: (tx: unknown) => unknown) => callback({
      update: () => ({ set: (values: unknown) => {
        mocks.set(values)
        return { where: () => ({ returning: () => ({ get: mocks.transactionReturning }), run: vi.fn() }) }
      } }),
      select: mocks.select,
      insert: () => ({ values: (values: unknown) => {
        mocks.insert(values)
        return { run: mocks.insertRun }
      } }),
    }),
  }),
}))

import { PUT } from './route'

const existingVariant = {
  id: 10,
  reportId: 3,
  variant: 'leadership',
  sourceDraft: '- 完成工作事项',
  finalContent: '旧终版',
  finalStatus: 'current',
  templateId: 'official-general',
  templateName: '通用模板',
  templateContent: '# 模板',
  aiStyle: 'formal',
  sourceRevision: 2,
  structureCompletenessRule: { version: 'next-week-plan-structure/v1', nextWeekPlan: 'required' },
}

function request(sourceRevision: number) {
  return new Request('http://localhost/api/reports/3/final', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variant: 'leadership',
      content: '新终版',
      sourceRevision,
      templateId: 'official-general',
      templateName: '通用模板',
      templateContent: '# 模板',
      aiStyle: 'formal',
    }),
  })
}

describe('PUT /api/reports/[id]/final', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findVariant.mockResolvedValue(existingVariant)
    mocks.insertRun.mockReturnValue(undefined)
    mocks.transactionReturning.mockReturnValue(existingVariant)
  })

  it('rejects a preview generated from an outdated source revision', async () => {
    const response = await PUT(request(1), { params: Promise.resolve({ id: '3' }) })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.code).toBe('SOURCE_REVISION_CONFLICT')
    expect(mocks.returning).not.toHaveBeenCalled()
  })

  it('saves and scores the selected audience variant when the revision matches', async () => {
    const updated = { ...existingVariant, finalContent: '新终版', scoreStatus: 'pending' }
    mocks.transactionReturning.mockReturnValue(updated)

    const response = await PUT(request(2), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id: 10, variant: 'leadership', finalContent: '新终版' })
  })

  it('retains the adopted contract when a direct edit submits different template text', async () => {
    mocks.transactionReturning.mockReturnValue({ ...existingVariant, finalContent: '新终版', scoreStatus: 'pending' })
    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
        templateContent: '明确禁止下周计划章节。',
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      structureCompletenessRule: { version: 'next-week-plan-structure/v1', nextWeekPlan: 'required' },
    }))
  })

  it('saves a legacy personal final without creating a variant or generation record', async () => {
    mocks.findVariant.mockResolvedValue(undefined)
    mocks.findReport.mockResolvedValue({ id: 3, content: '旧版终稿' })
    mocks.returning.mockResolvedValue([{ id: 3, content: '已编辑旧版终稿', scoreStatus: 'pending' }])

    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: 'personal', content: '已编辑旧版终稿' }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    expect(mocks.findProposal).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('records a direct edit after an accepted session without changing its plan records', async () => {
    const sessionVariant = { ...existingVariant, acceptedProposalId: 44 }
    mocks.findVariant.mockResolvedValue(sessionVariant)
    mocks.transactionReturning.mockReturnValue({ ...sessionVariant, finalContent: '会话后编辑', scoreStatus: 'pending' })
    mocks.findProposal.mockResolvedValue({ id: 44, sessionId: 9 })
    mocks.findSession.mockResolvedValue({ id: 9, reportId: 3 })
    const selection = (value: unknown) => ({
      from: () => ({ where: () => ({ get: () => value, orderBy: () => ({ limit: () => ({ get: () => value }) }) }) }),
    })
    mocks.select
      .mockReturnValueOnce(selection({ id: 44, sessionId: 9 }))
      .mockReturnValueOnce(selection({ id: 9, reportId: 3 }))
      .mockReturnValueOnce(selection({ sequence: 12 }))
    mocks.insert.mockResolvedValue(undefined)

    const response = await PUT(request(2), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 9,
      sequence: 13,
      content: '会话基线后的用户编辑。',
    }))
    expect(mocks.insertRun).toHaveBeenCalled()
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ baselineFinalContent: '会话后编辑' }))
  })

  it('writes back an official template and valid AI style key onto the variant', async () => {
    mocks.findAIStyle.mockResolvedValue({ key: 'formal', label: '正式' })
    mocks.transactionReturning.mockReturnValue({ ...existingVariant, finalContent: '新终版', templateId: 'official-tech-dev', templateName: '技术研发专属周报模板', aiStyle: 'formal' })

    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
        templateId: 'official-tech-dev', aiStyleKey: 'formal',
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      templateId: 'official-tech-dev',
      templateName: '技术研发专属周报模板',
      templateContent: expect.stringContaining('研发周报'),
      aiStyle: 'formal',
    }))
  })

  it('returns 400 for an unknown templateId', async () => {
    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
        templateId: 'official-nonexistent',
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for an unknown aiStyleKey', async () => {
    mocks.findAIStyle.mockResolvedValue(undefined)

    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
        aiStyleKey: 'nonexistent-style',
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('leaves template and style fields unchanged when both are omitted', async () => {
    mocks.transactionReturning.mockReturnValue({ ...existingVariant, finalContent: '新终版' })

    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    const setCall = mocks.set.mock.calls.find((call: unknown[]) => (call[0] as Record<string, unknown>).finalContent === '新终版')
    expect(setCall).toBeDefined()
    const setValues = setCall![0] as Record<string, unknown>
    expect(setValues.templateId).toBeUndefined()
    expect(setValues.templateName).toBeUndefined()
    expect(setValues.templateContent).toBeUndefined()
    expect(setValues.aiStyle).toBeUndefined()
  })

  it('normalizes structureCompletenessRule from the new template content when a template is written back', async () => {
    mocks.transactionReturning.mockReturnValue({ ...existingVariant, finalContent: '新终版' })

    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
        templateId: 'official-minimal',
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(200)
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      templateContent: expect.stringContaining('极简'),
    }))
  })

  it('returns 400 INVALID_INPUT when templateId is not a string', async () => {
    const response = await PUT(new Request('http://localhost/api/reports/3/final', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variant: 'leadership', content: '新终版', sourceRevision: 2,
        templateId: 123,
      }),
    }), { params: Promise.resolve({ id: '3' }) })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.code).toBe('INVALID_INPUT')
  })
})
