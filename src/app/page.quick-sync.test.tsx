import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import TimelinePage from './page'
import {
  SyncAllSourcesButton,
  SyncAllSourcesProvider,
} from '@/components/SyncAllSources'
import type { HeatmapData } from '@/components/ActivityHeatmap'
import type { RawEvent } from '@/lib/db/schema'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/components/QuickInputBar', () => ({
  QuickInputBar: () => null,
}))

vi.mock('@/components/TimelineView', () => ({
  TimelineView: ({ events }: { events: RawEvent[] }) => (
    <div>{events.map((event) => <span key={event.id}>{event.content}</span>)}</div>
  ),
}))

vi.mock('@/components/TimelinePlanPanel', () => ({
  TimelinePlanPanel: () => null,
}))

vi.mock('@/components/SourceFilterPanel', () => ({
  SourceFilterPanel: () => null,
}))

vi.mock('@/components/ActivityHeatmap', () => ({
  ActivityHeatmap: ({ data }: { data: HeatmapData[] }) => (
    <div>热力图事件 {data.reduce((total, item) => total + item.count, 0)}</div>
  ),
}))

const mockFetch = vi.fn()
global.fetch = mockFetch
let syncPayload: unknown

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('TimelinePage quick sync coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    syncPayload = {
      results: [{
        sourceId: 1,
        sourceName: 'alpha',
        status: 'success',
        commitsCount: 1,
        eventsCount: 1,
      }],
    }

    let eventsRequestCount = 0
    let heatmapRequestCount = 0
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('/api/events?')) {
        eventsRequestCount += 1
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            events: eventsRequestCount === 1
              ? [{ id: 1, content: '旧事件' }]
              : [{ id: 2, content: '同步后的新事件' }, { id: 1, content: '旧事件' }],
            nextCursor: null,
            hasMore: false,
          }),
        })
      }
      if (url === '/api/events/heatmap') {
        heatmapRequestCount += 1
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ date: '2026-08-30', count: heatmapRequestCount }],
          }),
        })
      }
      if (url === '/api/collect/git-remote/sync') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(syncPayload),
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  it('reloads timeline events and heatmap data after syncing', async () => {
    const user = userEvent.setup()
    render(
      <SyncAllSourcesProvider>
        <SyncAllSourcesButton />
        <TimelinePage />
      </SyncAllSourcesProvider>,
    )

    await screen.findByText('旧事件')
    expect(screen.getByText('热力图事件 1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sync all sources' }))

    await screen.findByText('同步后的新事件')
    await waitFor(() => {
      expect(screen.getByText('热力图事件 2')).toBeInTheDocument()
    })
  })

  it('does not reload timeline data for an invalid sync response', async () => {
    syncPayload = {}
    const user = userEvent.setup()
    render(
      <SyncAllSourcesProvider>
        <SyncAllSourcesButton />
        <TimelinePage />
      </SyncAllSourcesProvider>,
    )

    await screen.findByText('旧事件')
    await user.click(screen.getByRole('button', { name: 'Sync all sources' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Invalid sync response format')
    })
    const requestUrls = mockFetch.mock.calls.map(([input]) => String(input))
    expect(requestUrls.filter((url) => url.startsWith('/api/events?'))).toHaveLength(1)
    expect(requestUrls.filter((url) => url === '/api/events/heatmap')).toHaveLength(1)
  })
})
