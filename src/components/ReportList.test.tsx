import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ReportList } from './ReportList'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response
}

const reportsPayload = {
  reports: [
    {
      id: 7,
      title: 'Week 44',
      weekStart: '2026-10-26',
      weekEnd: '2026-11-01',
      createdAt: '2026-11-02T08:00:00Z',
      content: '',
    },
    {
      id: 5,
      title: 'Week 43',
      weekStart: '2026-10-19',
      weekEnd: '2026-10-25',
      createdAt: '2026-10-26T08:00:00Z',
      content: '',
    },
  ],
}

function detailFor(
  summary: { id: number; title: string; weekStart: string; weekEnd: string; createdAt: string },
  variants: Array<{
    variant: 'leadership' | 'personal'
    sourceDraft: string
    finalContent: string | null
    finalStatus: 'none' | 'current' | 'stale'
    sourceRevision: number
    templateName: string | null
  }>,
) {
  return { ...summary, variants }
}

const leadershipFinal = {
  variant: 'leadership' as const,
  sourceDraft: 'LEADERSHIP SOURCE TEXT',
  finalContent: '# Leadership final\n\nShipped the release.',
  finalStatus: 'current' as const,
  sourceRevision: 3,
  templateName: 'Technical weekly',
}

const personalNoFinal = {
  variant: 'personal' as const,
  sourceDraft: 'PERSONAL SOURCE TEXT',
  finalContent: null,
  finalStatus: 'none' as const,
  sourceRevision: 3,
  templateName: null,
}

function routeReports(
  detail: ReturnType<typeof detailFor>,
  list: unknown = reportsPayload,
) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/reports') return jsonResponse(list)
    if (path === `/api/reports/${detail.id}`) return jsonResponse(detail)
    return jsonResponse({ error: 'Not found' }, false)
  })
}

describe('ReportList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  it('loads the numbered index and previews the selected leadership final', async () => {
    routeReports(detailFor(reportsPayload.reports[0], [leadershipFinal, personalNoFinal]))

    render(<ReportList />)

    expect(screen.getByRole('heading', { name: 'Report library' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New report' })).toHaveAttribute('href', '/new')

    expect(await screen.findByText('R7')).toBeInTheDocument()
    expect(screen.getByText('R5')).toBeInTheDocument()
    expect(screen.getAllByText('Week 44').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Oct 26, 2026/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Created/).length).toBeGreaterThan(0)

    expect(await screen.findByText('Shipped the release.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Leadership/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Source revision 3')).toBeInTheDocument()
    expect(screen.getByText('Technical weekly')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open full review' })).toHaveAttribute(
      'href',
      '/reports/7?audience=leadership',
    )
    expect(
      screen.getByRole('link', { name: 'Open full review for Week 44' }),
    ).toHaveAttribute('href', '/reports/7?audience=leadership')
    expect(mockFetch).toHaveBeenCalledWith('/api/reports', expect.anything())
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/7', expect.anything())
  })

  it('keeps audiences separate and shows an explicit no-final state instead of the source draft', async () => {
    routeReports(detailFor(reportsPayload.reports[0], [leadershipFinal, personalNoFinal]))

    render(<ReportList />)
    expect(await screen.findByText('Shipped the release.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Personal/ }))

    expect(await screen.findByText('No final report yet')).toBeInTheDocument()
    expect(screen.getByText(/only a source draft/i)).toBeInTheDocument()
    expect(screen.queryByText('PERSONAL SOURCE TEXT')).not.toBeInTheDocument()
    expect(screen.queryByText('Shipped the release.')).not.toBeInTheDocument()
    // The previewed audience must travel with the full-review link so the
    // workspace opens the same variant instead of defaulting to Personal.
    expect(screen.getByRole('link', { name: 'Open full review' })).toHaveAttribute(
      'href',
      '/reports/7?audience=personal',
    )

    fireEvent.click(screen.getByRole('tab', { name: /Leadership/ }))
    expect(await screen.findByText('Shipped the release.')).toBeInTheDocument()
  })

  it('does not fall back to the other audience version when a variant is missing', async () => {
    const personalFinal = {
      ...personalNoFinal,
      finalContent: 'Personal-only final content.',
      finalStatus: 'current' as const,
    }
    routeReports(detailFor(reportsPayload.reports[0], [personalFinal]))

    render(<ReportList />)

    expect(await screen.findByText('No leadership version')).toBeInTheDocument()
    expect(screen.queryByText('Personal-only final content.')).not.toBeInTheDocument()
    // A missing audience has no full-review CTA that could open the other one.
    expect(screen.queryByRole('link', { name: 'Open full review' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Personal/ }))
    expect(await screen.findByText('Personal-only final content.')).toBeInTheDocument()
  })

  it('uses the server search endpoint and keeps the previous selection when it still matches', async () => {
    const detail = detailFor(reportsPayload.reports[0], [leadershipFinal, personalNoFinal])
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/reports') return jsonResponse(reportsPayload)
      if (path === '/api/reports/search?q=week') return jsonResponse(reportsPayload)
      if (path === '/api/reports/7') return jsonResponse(detail)
      return jsonResponse({ error: 'Not found' }, false)
    })

    render(<ReportList />)
    await screen.findByText('R7')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search reports' }), {
      target: { value: 'week' },
    })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/reports/search?q=week', expect.anything())
    })
    expect(await screen.findByRole('heading', { name: 'Search results' })).toBeInTheDocument()
    expect(screen.getByText('R7')).toBeInTheDocument()
  })

  it('shows a distinct empty state for a search with no matches', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/reports') return jsonResponse(reportsPayload)
      if (path === '/api/reports/7') {
        return jsonResponse(detailFor(reportsPayload.reports[0], [leadershipFinal, personalNoFinal]))
      }
      if (path === '/api/reports/search?q=nothing') return jsonResponse({ reports: [] })
      return jsonResponse({ error: 'Not found' }, false)
    })

    render(<ReportList />)
    await screen.findByText('R7')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search reports' }), {
      target: { value: 'nothing' },
    })

    expect(await screen.findByText('No matching reports')).toBeInTheDocument()
    expect(screen.queryByText('R7')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(await screen.findByText('R7')).toBeInTheDocument()
  })

  it('deletes through the API after confirmation and moves selection to the next report', async () => {
    const secondDetail = detailFor(reportsPayload.reports[1], [leadershipFinal, personalNoFinal])
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/reports') return jsonResponse(reportsPayload)
      if (path === '/api/reports/7' && init?.method === 'DELETE') return jsonResponse({ success: true })
      if (path === '/api/reports/7') {
        return jsonResponse(detailFor(reportsPayload.reports[0], [leadershipFinal, personalNoFinal]))
      }
      if (path === '/api/reports/5') return jsonResponse(secondDetail)
      return jsonResponse({ error: 'Not found' }, false)
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ReportList />)
    await screen.findByText('R7')

    fireEvent.click(screen.getByRole('button', { name: 'Delete Week 44' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/reports/7', {
        method: 'DELETE',
        headers: {},
      })
    })
    await waitFor(() => {
      expect(screen.queryByText('R7')).not.toBeInTheDocument()
    })
    expect(screen.getByText('R5')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Report deleted')
  })

  it('keeps the report when the server refuses deletion', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/reports') return jsonResponse(reportsPayload)
      if (path === '/api/reports/7' && init?.method === 'DELETE') {
        return jsonResponse(
          { error: 'This report contains generation audit records.' },
          false,
        )
      }
      if (path === '/api/reports/7') {
        return jsonResponse(detailFor(reportsPayload.reports[0], [leadershipFinal, personalNoFinal]))
      }
      return jsonResponse({ error: 'Not found' }, false)
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ReportList />)
    await screen.findByText('R7')

    fireEvent.click(screen.getByRole('button', { name: 'Delete Week 44' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('This report contains generation audit records.')
    })
    expect(screen.getByText('R7')).toBeInTheDocument()
  })

  it('shows an explicit loading error with a retry action', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ error: 'Database unavailable' }, false))

    render(<ReportList />)

    expect(await screen.findByText('Reports could not load')).toBeInTheDocument()
    expect(screen.getByText('Database unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('shows the empty-library guidance when no reports exist', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/reports') return jsonResponse({ reports: [] })
      return jsonResponse({ error: 'Not found' }, false)
    })

    render(<ReportList />)

    expect(await screen.findByText('No reports yet')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'New report' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: 'New report' })[0]).toHaveAttribute('href', '/new')
    expect(screen.getByText('Select a report')).toBeInTheDocument()
  })
})
