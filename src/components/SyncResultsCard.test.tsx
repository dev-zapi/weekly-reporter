import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SyncResultsCard } from './SyncResultsCard'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

describe('SyncResultsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps stable source references and expands long failures with keyboard-operable controls', async () => {
    const user = userEvent.setup()
    render(
      <SyncResultsCard
        results={[{
          sourceId: 12,
          sourceName: 'backend',
          status: 'failed',
          commitsCount: 0,
          eventsCount: 0,
          error: `Repository lookup failed: ${'detail '.repeat(20)}`,
        }]}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('#12')).toBeInTheDocument()
    expect(screen.getByText('0 succeeded')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    const expand = screen.getByRole('button', { name: 'Expand' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)
    expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('removes a failed branch through the existing source mutation and refreshes records', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)
    const onSourceChanged = vi.fn()
    const user = userEvent.setup()
    render(
      <SyncResultsCard
        results={[{
          sourceId: 12,
          sourceName: 'backend',
          status: 'success',
          commitsCount: 3,
          eventsCount: 2,
          branches: [
            { name: 'main', status: 'success', commitsCount: 3 },
            { name: 'topic', status: 'failed', commitsCount: 0, error: 'Branch not found' },
          ],
        }]}
        onClose={vi.fn()}
        onSourceChanged={onSourceChanged}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Remove branch topic' }))

    await waitFor(() => expect(onSourceChanged).toHaveBeenCalledTimes(1))
    expect(mockFetch).toHaveBeenCalledWith('/api/collect/sources/12', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ removeBranch: 'topic' }),
    }))
    expect(screen.queryByRole('button', { name: 'Remove branch topic' })).not.toBeInTheDocument()
    expect(screen.queryByText('topic')).not.toBeInTheDocument()
  })
})
