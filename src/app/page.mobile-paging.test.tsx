import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TimelinePage from './page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/components/SyncAllSources', () => ({
  useSyncAllSources: () => ({ completionVersion: 0 }),
}))

vi.mock('@/components/QuickInputBar', () => ({
  QuickInputBar: () => null,
}))

vi.mock('@/components/TimelineView', () => ({
  TimelineView: ({ events }: { events: Array<{ id: number; content: string }> }) => (
    <div>{events.map((event) => <span key={event.id}>{event.content}</span>)}</div>
  ),
}))

vi.mock('@/components/TimelineEvidenceTrace', () => ({
  TimelineEvidenceTrace: () => <div data-testid="evidence-trace" />,
}))

vi.mock('@/components/TimelineReadiness', () => ({
  TimelineReadiness: () => <div data-testid="readiness" />,
}))

vi.mock('@/components/ActivityHeatmap', () => ({
  ActivityHeatmap: () => <div data-testid="activity" />,
}))

vi.mock('@/components/TimelinePlanPanel', () => ({
  TimelinePlanPanel: () => <div data-testid="plan" />,
}))

vi.mock('@/components/SourceFilterPanel', () => ({
  SourceFilterPanel: () => <div data-testid="source-filter" />,
}))

vi.mock('@/components/TagFilterPanel', () => ({
  TagFilterPanel: () => <div data-testid="tag-filter" />,
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

let observerCount = 0

class IntersectionObserverMock {
  constructor() {
    observerCount += 1
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function collapseToMobileLayout() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

describe('TimelinePage one-column paging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    observerCount = 0
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    collapseToMobileLayout()

    let eventsRequestCount = 0
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('/api/events?')) {
        eventsRequestCount += 1
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            events: eventsRequestCount === 1
              ? [{ id: 1, content: 'First page event' }]
              : [{ id: 2, content: 'Second page event' }, { id: 1, content: 'First page event' }],
            nextCursor: eventsRequestCount === 1 ? { id: 1, eventTime: 1 } : null,
            hasMore: eventsRequestCount === 1,
          }),
        })
      }
      if (url === '/api/events/heatmap') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not auto-append events above the context aside in the one-column layout', async () => {
    render(<TimelinePage />)

    expect(await screen.findByText('First page event')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()

    // No sentinel observer means scrolling cannot push Evidence trace,
    // readiness, plans, and filters farther down the page.
    expect(observerCount).toBe(0)
    const eventRequests = () => mockFetch.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith('/api/events?') && !url.includes('cursorId'))
    await waitFor(() => expect(eventRequests()).toHaveLength(1))
  })

  it('still loads the next page when the user explicitly asks for it', async () => {
    const user = userEvent.setup()
    render(<TimelinePage />)

    await screen.findByText('First page event')
    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Second page event')).toBeInTheDocument()
    expect(mockFetch.mock.calls.some(([input]) => String(input).includes('cursorId=1'))).toBe(true)
  })
})
