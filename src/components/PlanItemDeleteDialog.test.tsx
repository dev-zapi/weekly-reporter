import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlanItemDeleteDialog } from './PlanItemDeleteDialog'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

describe('PlanItemDeleteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists the events that reference the item before deletion', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        referrers: [
          { id: 11, content: 'Worked on %5', eventTime: '2026-10-14T09:00:00.000Z' },
        ],
      }),
    })

    render(<PlanItemDeleteDialog itemId={5} onClose={vi.fn()} onConfirm={vi.fn()} />)

    expect(await screen.findByText('Worked on %5')).toBeInTheDocument()
    expect(mockFetch.mock.calls[0][0]).toBe('/api/plan-items/5')
  })

  it('warns that deleting creates dangling references', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        referrers: [
          { id: 11, content: 'Worked on %5', eventTime: '2026-10-14T09:00:00.000Z' },
        ],
      }),
    })

    render(<PlanItemDeleteDialog itemId={5} onClose={vi.fn()} onConfirm={vi.fn()} />)

    expect(await screen.findByText(/referenced by 1 event/i)).toBeInTheDocument()
  })

  it('shows a no-reference message when nothing references the item', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ referrers: [] }) })

    render(<PlanItemDeleteDialog itemId={5} onClose={vi.fn()} onConfirm={vi.fn()} />)

    expect(await screen.findByText(/no events reference this item/i)).toBeInTheDocument()
  })

  it('confirms deletion with the item id', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ referrers: [] }) })

    render(<PlanItemDeleteDialog itemId={5} onClose={vi.fn()} onConfirm={onConfirm} />)

    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    expect(onConfirm).toHaveBeenCalledWith(5)
  })

  it('closes without deleting when cancelled', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ referrers: [] }) })

    render(<PlanItemDeleteDialog itemId={5} onClose={onClose} onConfirm={onConfirm} />)

    await user.click(await screen.findByRole('button', { name: /cancel/i }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
