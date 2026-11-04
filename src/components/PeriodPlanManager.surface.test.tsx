import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeriodPlanManager } from './PeriodPlanManager'
import type { PeriodPlanItem } from '@/lib/db/schema'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function makeItem(
  overrides: Partial<PeriodPlanItem> & { fulfillmentCount?: number; commentCount?: number } = {},
): PeriodPlanItem {
  return {
    id: 1,
    periodPlanId: 1,
    text: 'Item',
    status: 'planned',
    priority: 'normal',
    isImportant: false,
    isUrgent: false,
    projectScope: 'work',
    parentItemId: null,
    deferredFromItemId: null,
    position: 1,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  }
}

function okJson(payload: unknown) {
  return Promise.resolve({ ok: true, json: async () => payload })
}

function setupApi(items: Array<PeriodPlanItem & { fulfillmentCount?: number; commentCount?: number }>) {
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('scope=month')) {
      return okJson({ plan: null, items: [] })
    }
    if (method === 'GET' && url.startsWith('/api/plans')) {
      return okJson({ plan: { id: 1 }, items })
    }
    return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'unexpected' }) })
  })
}

describe('PeriodPlanManager surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the C split body with a title-first primary column and persistent inspector', async () => {
    setupApi([makeItem({ id: 1, text: 'First item' })])

    render(<PeriodPlanManager />)

    expect(await screen.findByText('First item')).toBeInTheDocument()

    const workspace = screen.getByRole('region', { name: 'Plan workspace' })
    const inspector = screen.getByRole('complementary', { name: 'Plan inspector' })
    expect(within(workspace).getByRole('heading', { level: 1, name: 'Plan items' })).toBeInTheDocument()
    expect(within(workspace).getByRole('region', { name: 'Plan composition' })).toBeInTheDocument()
    expect(within(inspector).getByRole('region', { name: 'Selected plan item' })).toBeInTheDocument()
    expect(within(inspector).getByRole('region', { name: 'Plan period summary' })).toBeInTheDocument()
  })

  it('numbers rows and moves the inspector with the selected item', async () => {
    const user = userEvent.setup()
    setupApi([
      makeItem({ id: 1, text: 'First item', position: 1 }),
      makeItem({ id: 2, text: 'Second item', position: 2 }),
    ])

    render(<PeriodPlanManager />)

    expect(await screen.findByText('Second item')).toBeInTheDocument()

    const first = screen.getByRole('button', { name: 'Inspect plan item %1' })
    const second = screen.getByRole('button', { name: 'Inspect plan item %2' })
    expect(within(first).getByText('1')).toBeInTheDocument()
    expect(within(second).getByText('2')).toBeInTheDocument()
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(second).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Selected item: First item')).toBeInTheDocument()

    await user.click(second)

    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Selected item: Second item')).toBeInTheDocument()
    expect(screen.queryByText('Selected item: First item')).not.toBeInTheDocument()
  })

  it('keeps every rich list operation alongside the numbered layout', async () => {
    setupApi([
      makeItem({
        id: 1,
        text: 'First item',
        priority: 'high',
        isImportant: true,
        fulfillmentCount: 3,
        commentCount: 2,
      }),
      makeItem({ id: 2, text: 'Second item', status: 'done', position: 2 }),
    ])

    render(<PeriodPlanManager />)

    expect(await screen.findByText('Second item')).toBeInTheDocument()

    expect(screen.getAllByLabelText(/^Status for %/)).toHaveLength(2)
    expect(screen.getAllByLabelText(/^Priority for %/)).toHaveLength(2)
    expect(screen.getAllByLabelText(/^Project scope for %/)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Toggle plan item important flag' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Toggle plan item urgent flag' })).toHaveLength(2)
    expect(screen.getAllByLabelText('Defer to next period')).toHaveLength(2)
    expect(screen.getAllByLabelText('Delete item')).toHaveLength(2)
    expect(screen.getAllByLabelText('Toggle comments')).toHaveLength(2)
    expect(screen.getAllByLabelText('Toggle fulfillment events')).toHaveLength(2)

    // All five lifecycle states stay visible in the period readiness panel.
    const breakdown = screen.getByRole('group', { name: 'Status breakdown' })
    for (const label of ['Planned', 'In Progress', 'Done', 'Cancelled', 'Deferred']) {
      expect(within(breakdown).getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('1 of 2 completed')).toBeInTheDocument()
  })

  it('keeps week/month scope navigation and the period controls in the body', async () => {
    const user = userEvent.setup()
    setupApi([makeItem({ id: 1, text: 'Week task' })])

    render(<PeriodPlanManager />)

    expect(await screen.findByText('Week task')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Month' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByLabelText('Previous period')).toBeInTheDocument()
    expect(screen.getByLabelText('Next period')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Month' }))

    expect(screen.getByRole('tab', { name: 'Month' })).toHaveAttribute('aria-selected', 'true')
    expect(
      mockFetch.mock.calls.some((call) => String(call[0]).includes('scope=month')),
    ).toBe(true)
  })
})
