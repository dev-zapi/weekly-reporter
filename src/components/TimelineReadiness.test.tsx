import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { TimelineReadiness } from './TimelineReadiness'
import { getWeekPeriodRange } from '@/lib/periods'

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-client', () => ({
  apiFetch,
  traceSuffix: () => '',
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('TimelineReadiness', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('scopes the report lookup to the current week and says Not created when it is missing', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/plans?')) {
        return Promise.resolve(jsonResponse({
          items: [{ status: 'done' }, { status: 'in_progress' }],
        }))
      }
      if (url.startsWith('/api/reports/search?')) {
        return Promise.resolve(jsonResponse({ reports: [] }))
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const week = getWeekPeriodRange(new Date())
    render(<TimelineReadiness eventsCount={4} />)

    await screen.findByText('1/2 done')
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        `/api/reports/search?startDate=${week.start}&endDate=${week.end}`,
      ),
      expect.anything(),
    )

    const planCell = screen.getByText('1/2 done').closest('[data-state]')
    expect(planCell).toHaveAttribute('data-state', 'pending')

    // Both report cells must say the current week has no report. An older
    // report is never silently substituted.
    expect(screen.getAllByText('Not created')).toHaveLength(2)
    expect(screen.getAllByText('No report for this week')).toHaveLength(2)

    const workCell = screen.getByText('4 loaded').closest('[data-state]')
    expect(workCell).toHaveAttribute('data-state', 'ready')
  })

  it('keeps leadership and personal final states separate', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/plans?')) {
        return Promise.resolve(jsonResponse({ items: [{ status: 'done' }] }))
      }
      if (url.startsWith('/api/reports/search?')) {
        return Promise.resolve(jsonResponse({
          reports: [{
            id: 9,
            title: 'Week report',
            weekStart: '2026-01-05',
            weekEnd: '2026-01-11',
            variants: [
              {
                variant: 'leadership',
                sourceDraft: '- Leadership fact',
                sourceRevision: 3,
                finalStatus: 'current',
              },
              {
                variant: 'personal',
                sourceDraft: '- Personal fact',
                sourceRevision: 2,
                finalStatus: 'stale',
              },
            ],
          }],
        }))
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    render(<TimelineReadiness eventsCount={1} />)

    const sourceCell = (await screen.findByText('Source draft')).closest('[data-state]') as HTMLElement
    expect(within(sourceCell).getByText('R3')).toBeInTheDocument()
    expect(within(sourceCell).getByText('R2')).toBeInTheDocument()
    expect(sourceCell).toHaveAttribute('data-state', 'ready')

    const finalCell = screen.getByText('Final review').closest('[data-state]') as HTMLElement
    expect(within(finalCell).getByText('Current')).toBeInTheDocument()
    expect(within(finalCell).getByText('Stale')).toBeInTheDocument()
    expect(finalCell).toHaveAttribute('data-state', 'pending')
  })

  it('does not treat a legacy report body as a source draft or final', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/plans?')) {
        return Promise.resolve(jsonResponse({ items: [] }))
      }
      if (url.startsWith('/api/reports/search?')) {
        return Promise.resolve(jsonResponse({
          reports: [{
            id: 4,
            title: 'Legacy week',
            weekStart: '2025-01-06',
            weekEnd: '2025-01-12',
            content: 'An older report body that must not become a final.',
            variants: [],
          }],
        }))
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    render(<TimelineReadiness eventsCount={0} />)

    await screen.findAllByText('No snapshot')
    expect(screen.getAllByText('No snapshot')).toHaveLength(2)
    expect(screen.queryByText(/older report body/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Current')).not.toBeInTheDocument()
  })
})
