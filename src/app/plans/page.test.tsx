import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import PlansPage from './page'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

describe('PlansPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ plan: null, items: [] }) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the month named by the deep link', async () => {
    const ui = await PlansPage({
      searchParams: Promise.resolve({ scope: 'month', start: '2026-03-01' }),
    })
    render(ui)

    await waitFor(() => {
      expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('month=2026-03'))).toBe(true)
    })
  })

  it('opens the week named by the deep link', async () => {
    const ui = await PlansPage({
      searchParams: Promise.resolve({ scope: 'week', start: '2026-10-12' }),
    })
    render(ui)

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some((call) => String(call[0]).includes('weekStart=2026-10-12')),
      ).toBe(true)
    })
  })

  it('defaults to the current week without a deep link', async () => {
    const ui = await PlansPage({ searchParams: Promise.resolve({}) })
    render(ui)

    await waitFor(() => {
      expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('scope=week'))).toBe(true)
    })
  })
})
