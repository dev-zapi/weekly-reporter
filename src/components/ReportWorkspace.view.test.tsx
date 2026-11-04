import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ReportWorkspace } from './ReportWorkspace'

const mockFetch = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
global.fetch = mockFetch

describe('ReportWorkspace read-only typography', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/reports/1') return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 1,
          title: 'Test Report',
          weekStart: '2026-08-17',
          weekEnd: '2026-08-23',
          variants: [{
            id: 1,
            reportId: 1,
            variant: 'personal',
            sourceDraft: '- 原稿事项',
            finalContent: '### 工作小结\n\n这是正文段落。',
            finalStatus: 'current',
            sourceRevision: 1,
            scoreStatus: 'completed',
          }],
        }),
      })
      if (url === '/api/templates') return Promise.resolve({ ok: true, json: () => Promise.resolve({ official: [], user: [] }) })
      if (url === '/api/prompts/styles') return Promise.resolve({ ok: true, json: () => Promise.resolve({ styles: [] }) })
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Unknown' }) })
    })
  })

  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('keeps the final report body on the fixed light reading surface', async () => {
    render(<ReportWorkspace reportId={1} editable={false} />)

    const heading = await screen.findByRole('heading', { level: 3, name: '工作小结' })
    const reportBody = heading.closest('[data-testid="final-report-body"]')
    expect(reportBody).toBeInTheDocument()
    // The fixed-light report surface must not take theme color utilities.
    expect(reportBody).not.toHaveClass('bg-card', 'text-card-foreground')
    expect(reportBody).not.toHaveClass('report-view-content', 'prose-invert')

    await waitFor(() => expect(screen.getByTestId('source-draft-scroll')).toBeInTheDocument())
    expect(screen.getByTestId('source-draft-scroll')).not.toHaveClass('report-view-content')
  })

  it('does not let the dark theme repaint the fixed-light final report body', async () => {
    document.documentElement.classList.add('dark')

    render(<ReportWorkspace reportId={1} editable={false} />)

    const heading = await screen.findByRole('heading', { level: 3, name: '工作小结' })
    const reportBody = heading.closest('[data-testid="final-report-body"]')
    expect(reportBody).toBeInTheDocument()
    expect(reportBody).not.toHaveClass('bg-card', 'text-card-foreground')
    expect(reportBody?.className).not.toMatch(/(^|\s)dark:/)
  })
})
