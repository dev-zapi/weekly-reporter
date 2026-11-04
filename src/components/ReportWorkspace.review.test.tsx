import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReportWorkspace } from './ReportWorkspace'

const mockFetch = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
global.fetch = mockFetch

function mockReport(bundle: Record<string, unknown>) {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/reports/1') return Promise.resolve({ ok: true, json: () => Promise.resolve(bundle) })
    if (url === '/api/templates') return Promise.resolve({ ok: true, json: () => Promise.resolve({ official: [], user: [] }) })
    if (url === '/api/prompts/styles') return Promise.resolve({ ok: true, json: () => Promise.resolve({ styles: [] }) })
    if (url === '/api/reports/1/generation-sessions?variant=personal') return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) })
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Unknown' }) })
  })
}

const baseVariant = {
  id: 1,
  reportId: 1,
  variant: 'personal',
  sourceDraft: '- 本周原稿事项',
  finalContent: null,
  finalStatus: 'none',
  sourceRevision: 2,
  templateId: null,
  templateName: null,
  templateContent: null,
  structureCompletenessRule: null,
  aiStyle: null,
  acceptedProposalId: null,
  createdAt: new Date('2026-08-17T00:00:00Z'),
  updatedAt: new Date('2026-08-17T00:00:00Z'),
}

describe('ReportWorkspace review surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('states that a source draft is not a candidate final when no final exists', async () => {
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [baseVariant],
      snapshots: [{ id: 10 }, { id: 11 }],
    })

    render(<ReportWorkspace reportId={1} editable={false} />)

    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    expect(screen.getByText('No final report yet')).toBeInTheDocument()
    expect(screen.getByText(/It is not a candidate final/)).toBeInTheDocument()
    expect(
      screen.getByText(/inventory of frozen evidence for the Personal audience/),
    ).toBeInTheDocument()
    expect(screen.getByText(/No final has been adopted for this audience/)).toBeInTheDocument()

    const gate = screen.getByRole('complementary', { name: 'Report review gate' })
    expect(within(gate).getByText('Not adopted')).toBeInTheDocument()
    expect(within(gate).getByText(/Adoption stays unavailable until a final exists/)).toBeInTheDocument()
    expect(within(gate).getByText('2 frozen events')).toBeInTheDocument()
  })

  it('exposes read-only source, rendered final, and comparison panes separately', async () => {
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [{
        ...baseVariant,
        sourceRevision: 3,
        finalContent: '### 工作小结\n\n这是终版正文。',
        finalStatus: 'current',
        templateName: '标准模板',
        aiStyle: 'formal',
        acceptedProposalId: 9,
      }],
      snapshots: [{ id: 10 }],
    })

    render(<ReportWorkspace reportId={1} editable={false} />)

    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    expect(screen.getByText('Final version available')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '工作小结' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Source draft' }))
    expect(screen.getByTestId('source-draft-scroll')).toBeVisible()
    expect(screen.getByText('本周原稿事项')).toBeInTheDocument()
    expect(screen.getByText('Read-only')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }))
    const sourceComparison = screen.getByLabelText('Source draft comparison')
    const finalComparison = screen.getByLabelText('Final report comparison')
    expect(within(sourceComparison).getByText('本周原稿事项')).toBeVisible()
    expect(within(finalComparison).getByText('工作小结')).toBeVisible()
    expect(within(finalComparison).getByText('这是终版正文。')).toBeVisible()

    const gate = screen.getByRole('complementary', { name: 'Report review gate' })
    expect(within(gate).getByText('Proposal #9 accepted')).toBeInTheDocument()
    expect(within(gate).getByText('标准模板')).toBeInTheDocument()
    expect(within(gate).getByText('formal')).toBeInTheDocument()
    expect(within(gate).getByText(/Acceptance and regeneration are recorded/)).toBeInTheDocument()
  })

  it('does not claim AI-session provenance for a final the user saved directly', async () => {
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [{
        ...baseVariant,
        finalContent: '### 工作小结\n\n用户直接保存的终版。',
        finalStatus: 'current',
        acceptedProposalId: null,
      }],
      snapshots: [{ id: 10 }],
    })

    render(<ReportWorkspace reportId={1} editable={false} />)

    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    const gate = screen.getByRole('complementary', { name: 'Report review gate' })
    expect(within(gate).getByText(/saved directly by the user/)).toBeInTheDocument()
    expect(within(gate).queryByText(/Acceptance and regeneration are recorded/)).not.toBeInTheDocument()
  })

  it('labels a retained final as stale after the source revision moves', async () => {
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [{
        ...baseVariant,
        sourceRevision: 4,
        finalContent: '### 工作小结\n\n旧终版正文。',
        finalStatus: 'stale',
      }],
      snapshots: [],
    })

    render(<ReportWorkspace reportId={1} editable={false} />)

    expect(await screen.findByText('Final version is stale')).toBeInTheDocument()
    expect(screen.getByText(/The source draft was regenerated to revision r4/)).toBeInTheDocument()
    expect(screen.getByText(/This final still reflects an earlier revision and is not current/)).toBeInTheDocument()

    const gate = screen.getByRole('complementary', { name: 'Report review gate' })
    expect(within(gate).getByText('Retained, not current')).toBeInTheDocument()
    expect(within(gate).getByText('Stale final')).toBeInTheDocument()
  })

  it('opens the audience carried from the library query instead of defaulting to Personal', async () => {
    const leadershipVariant = {
      ...baseVariant,
      id: 2,
      variant: 'leadership',
      sourceDraft: '- 领导版原稿事项',
      finalContent: '### 工作小结\n\n领导版终版正文。',
      finalStatus: 'current',
      sourceRevision: 3,
    }
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [baseVariant, leadershipVariant],
      snapshots: [{ id: 10 }],
    })

    render(<ReportWorkspace reportId={1} editable={false} initialAudience="leadership" />)

    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    expect(screen.getByText('领导版终版正文。')).toBeInTheDocument()
    expect(screen.queryByText('No final report yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Leadership/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Personal/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not substitute the other audience when the requested variant is missing', async () => {
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [baseVariant],
      snapshots: [{ id: 10 }],
    })

    render(<ReportWorkspace reportId={1} editable={false} initialAudience="leadership" />)

    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    expect(screen.getByText('No leadership version')).toBeInTheDocument()
    expect(screen.getByText(/kept separate and is not shown here/)).toBeInTheDocument()
    expect(screen.queryByText('No final report yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Leadership/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^Personal/ })).toHaveAttribute('aria-pressed', 'false')

    // Switching remains an explicit user action.
    fireEvent.click(screen.getByRole('button', { name: /^Personal/ }))
    expect(await screen.findByText('No final report yet')).toBeInTheDocument()
  })

  it('keeps edit and delete on the read-only route and regeneration on the edit route', async () => {
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [baseVariant],
      snapshots: [],
    })

    const { unmount } = render(<ReportWorkspace reportId={1} editable={false} />)
    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    unmount()

    vi.clearAllMocks()
    mockReport({
      id: 1,
      title: 'Test Report',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      variants: [baseVariant],
      snapshots: [],
    })
    render(<ReportWorkspace reportId={1} editable />)
    expect(await screen.findByRole('heading', { name: 'Test Report' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate source draft' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Create AI generation session' })).toBeInTheDocument())
  })
})
