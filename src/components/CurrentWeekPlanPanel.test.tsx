import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CurrentWeekPlanPanel } from './CurrentWeekPlanPanel'

const mockFetch = vi.fn()
global.fetch = mockFetch

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

describe('CurrentWeekPlanPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders loading state initially', () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // Never resolves

    render(<CurrentWeekPlanPanel />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('fetches current week plan on mount', async () => {
    const today = new Date()
    const dateStr = today.toISOString().split('T')[0]

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ plan: null, items: [] }),
    })

    render(<CurrentWeekPlanPanel />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/plans?scope=week&date=${dateStr}`),
        expect.any(Object)
      )
    })
  })

  it('renders empty state with guidance when no plan exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ plan: null, items: [] }),
    })

    render(<CurrentWeekPlanPanel />)

    await waitFor(() => {
      expect(screen.getByText(/no plan yet/i)).toBeInTheDocument()
    })

    expect(screen.getByRole('link', { name: /create plan/i })).toBeInTheDocument()
  })

  it('renders plan items with status and project scope markers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        plan: {
          id: 1,
          scope: 'week',
          periodStart: '2026-10-12',
          periodEnd: '2026-10-18',
        },
        items: [
          {
            id: 1,
            text: 'Review PR',
            status: 'in_progress',
            projectScope: 'work',
            position: 0,
          },
          {
            id: 2,
            text: 'Buy groceries',
            status: 'planned',
            projectScope: 'personal',
            position: 1,
          },
        ],
      }),
    })

    render(<CurrentWeekPlanPanel />)

    await waitFor(() => {
      expect(screen.getByText('Review PR')).toBeInTheDocument()
    })

    expect(screen.getByText('Buy groceries')).toBeInTheDocument()

    // Status markers
    expect(screen.getByText(/in progress/i)).toBeInTheDocument()
    expect(screen.getByText(/planned/i)).toBeInTheDocument()

    // Project scope markers
    expect(screen.getByText(/work/i)).toBeInTheDocument()
    expect(screen.getByText(/personal/i)).toBeInTheDocument()
  })

  it('provides link to /plans page', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        plan: { id: 1, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18' },
        items: [],
      }),
    })

    render(<CurrentWeekPlanPanel />)

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /manage plans/i })
      expect(link).toHaveAttribute('href', '/plans')
    })
  })

  it('renders error state when fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Network error' }),
    })

    render(<CurrentWeekPlanPanel />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/network error/i)).toBeInTheDocument()
    })
  })

  it('does not call /api/timeline/plans', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ plan: null, items: [] }),
    })

    render(<CurrentWeekPlanPanel />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    const calls = mockFetch.mock.calls
    const hasOldApiCall = calls.some(call => call[0].includes('/api/timeline/plans'))
    expect(hasOldApiCall).toBe(false)
  })
})
