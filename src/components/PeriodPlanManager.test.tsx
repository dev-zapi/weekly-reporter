import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeriodPlanManager } from './PeriodPlanManager'
import type { PeriodPlanItem } from '@/lib/db/schema'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function makeItem(overrides: Partial<PeriodPlanItem> = {}): PeriodPlanItem {
  return {
    id: 1,
    periodPlanId: 1,
    text: 'Item',
    status: 'planned',
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

/**
 * Route fetch calls by URL + method. GET /api/plans returns the given week
 * items; GET /api/plans?scope=month returns parent options.
 */
function setupApi(options: {
  items?: Array<PeriodPlanItem & { fulfillmentCount?: number }>
  parentItems?: PeriodPlanItem[]
  plan?: { id: number } | null
}) {
  const { items = [], parentItems = [], plan = null } = options
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('scope=month')) {
      return okJson({ plan: parentItems.length > 0 ? { id: 2 } : null, items: parentItems })
    }
    if (method === 'GET' && url.startsWith('/api/plan-items/')) {
      return okJson({ id: 5, referrers: [] })
    }
    if (method === 'GET' && url.startsWith('/api/plans')) {
      return okJson({ plan, items })
    }
    if (method === 'POST' && url === '/api/plan-items') {
      return Promise.resolve({ ok: true, status: 201, json: async () => makeItem({ id: 99, text: 'New' }) })
    }
    if (method === 'POST' && url.endsWith('/defer')) {
      return Promise.resolve({ ok: true, status: 201, json: async () => makeItem({ id: 100 }) })
    }
    if (method === 'PUT') {
      return okJson(makeItem())
    }
    if (method === 'DELETE') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ deleted: true }) })
    }
    return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'unexpected' }) })
  })
}

describe('PeriodPlanManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders with week scope by default', async () => {
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /week/i })).toBeInTheDocument()
    })
    expect(screen.getByRole('tab', { name: /month/i })).toBeInTheDocument()
  })

  it('shows empty state when no items', async () => {
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => {
      expect(screen.getByText(/no plans yet/i)).toBeInTheDocument()
    })
  })

  it('displays items when they exist', async () => {
    setupApi({ items: [makeItem({ id: 1, text: 'Test item' })] })
    render(<PeriodPlanManager />)

    await waitFor(() => {
      expect(screen.getByText('Test item')).toBeInTheDocument()
    })
  })

  it('shows completion count', async () => {
    setupApi({
      items: [
        makeItem({ id: 1, text: 'Item 1', status: 'done', position: 1 }),
        makeItem({ id: 2, text: 'Item 2', status: 'planned', position: 2 }),
        makeItem({ id: 3, text: 'Item 3', status: 'done', position: 3 }),
      ],
    })
    render(<PeriodPlanManager />)

    await waitFor(() => {
      expect(screen.getByText(/2 of 3 completed/i)).toBeInTheDocument()
    })
  })

  it('requests the current week range from the API', async () => {
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => {
      const planCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/api/plans?scope=week')
      )
      expect(planCall).toBeDefined()
      expect(planCall![0]).toContain('weekStart=')
      expect(planCall![0]).toContain('weekEnd=')
    })
  })

  it('toggles to month scope when clicking the month tab', async () => {
    const user = userEvent.setup()
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByRole('tab', { name: /month/i })).toBeInTheDocument())

    await user.click(screen.getByRole('tab', { name: /month/i }))

    await waitFor(() => {
      const monthCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('scope=month')
      )
      expect(monthCall).toBeDefined()
    })
  })

  it('navigates to the previous period', async () => {
    const user = userEvent.setup()
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText(/no plans yet/i)).toBeInTheDocument())
    const before = mockFetch.mock.calls.filter((c) => String(c[0]).includes('scope=week')).length

    await user.click(screen.getByRole('button', { name: /previous period/i }))

    await waitFor(() => {
      const after = mockFetch.mock.calls.filter((c) => String(c[0]).includes('scope=week')).length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('navigates to the next period', async () => {
    const user = userEvent.setup()
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText(/no plans yet/i)).toBeInTheDocument())
    const before = mockFetch.mock.calls.filter((c) => String(c[0]).includes('scope=week')).length

    await user.click(screen.getByRole('button', { name: /next period/i }))

    await waitFor(() => {
      const after = mockFetch.mock.calls.filter((c) => String(c[0]).includes('scope=week')).length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('adds a new item via the API', async () => {
    const user = userEvent.setup()
    setupApi({})
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText(/no plans yet/i)).toBeInTheDocument())

    const input = screen.getByPlaceholderText(/add a new plan item/i)
    await user.type(input, 'Write tests')
    await user.click(screen.getByRole('button', { name: /add/i }))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'POST' && call[0] === '/api/plan-items'
      )
      expect(postCall).toBeDefined()
      const body = JSON.parse(postCall![1].body as string)
      expect(body.text).toBe('Write tests')
      expect(body.scope).toBe('week')
      expect(body.projectScope).toBe('work')
    })
  })

  it('offers month items from the week-start month as parent options', async () => {
    setupApi({
      items: [makeItem({ id: 1, text: 'Week task' })],
      parentItems: [makeItem({ id: 50, text: 'Month goal', periodPlanId: 2 })],
    })
    render(<PeriodPlanManager />)

    await waitFor(() => {
      expect(screen.getByLabelText('Parent month item')).toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: 'Month goal' })).toBeInTheDocument()
  })

  it('links a week item to a month parent when selected', async () => {
    const user = userEvent.setup()
    setupApi({
      items: [makeItem({ id: 1, text: 'Week task' })],
      parentItems: [makeItem({ id: 50, text: 'Month goal', periodPlanId: 2 })],
    })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByLabelText('Parent month item')).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText('Parent month item'), '50')

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/1'
      )
      expect(putCall).toBeDefined()
      expect(JSON.parse(putCall![1].body as string)).toEqual({ parentItemId: 50 })
    })
  })

  it('defers an item only after confirmation', async () => {
    const user = userEvent.setup()
    setupApi({ items: [makeItem({ id: 7, text: 'Carry me' })] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Carry me')).toBeInTheDocument())

    await user.click(screen.getByLabelText('Defer to next period'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockFetch.mock.calls.some((c) => String(c[0]).endsWith('/defer'))).toBe(false)

    confirmSpy.mockReturnValue(true)
    await user.click(screen.getByLabelText('Defer to next period'))

    await waitFor(() => {
      expect(mockFetch.mock.calls.some((c) => String(c[0]) === '/api/plan-items/7/defer')).toBe(true)
    })
  })

  it('updates item status through the API', async () => {
    const user = userEvent.setup()
    setupApi({ items: [makeItem({ id: 3, text: 'Do it' })] })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Do it')).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText('Status'), 'done')

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/3'
      )
      expect(putCall).toBeDefined()
      expect(JSON.parse(putCall![1].body as string)).toEqual({ status: 'done' })
    })
  })

  it('deletes an item only after confirming in the dialog', async () => {
    const user = userEvent.setup()
    setupApi({ items: [makeItem({ id: 5, text: 'Remove me' })] })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Remove me')).toBeInTheDocument())

    await user.click(screen.getByLabelText('Delete item'))

    // Nothing is deleted until the confirmation dialog is accepted.
    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)

    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    await waitFor(() => {
      const deleteCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'DELETE' && call[0] === '/api/plan-items/5'
      )
      expect(deleteCall).toBeDefined()
    })
    await waitFor(() => {
      expect(screen.queryByText('Remove me')).not.toBeInTheDocument()
    })
  })

  it('opens the month period named by a deep link', async () => {
    setupApi({})
    render(<PeriodPlanManager initialScope="month" initialStart="2026-03-01" />)

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('scope=month')
      )
      expect(call).toBeDefined()
      expect(call![0]).toContain('month=2026-03')
    })
  })

  it('opens the week period named by a deep link', async () => {
    setupApi({})
    render(<PeriodPlanManager initialScope="week" initialStart="2026-10-12" />)

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/plans?scope=week')
      )
      expect(call).toBeDefined()
      expect(call![0]).toContain('weekStart=2026-10-12')
    })
  })

  it('falls back to the current period when the deep link start is invalid', async () => {
    setupApi({})
    render(<PeriodPlanManager initialScope="week" initialStart="garbage" />)

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/plans?scope=week')
      )
      expect(call).toBeDefined()
      expect(call![0]).toContain('weekStart=')
    })
  })

  it('shows the fulfillment count provided by the API', async () => {
    setupApi({ items: [{ ...makeItem({ id: 1, text: 'Counted' }), fulfillmentCount: 4 }] })
    render(<PeriodPlanManager />)

    await waitFor(() => {
      expect(screen.getByText(/4 fulfilled/i)).toBeInTheDocument()
    })
  })

  it('moves an item down by swapping positions', async () => {
    const user = userEvent.setup()
    setupApi({
      items: [
        makeItem({ id: 1, text: 'First', position: 1 }),
        makeItem({ id: 2, text: 'Second', position: 2 }),
      ],
    })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('First')).toBeInTheDocument())

    const moveDownButtons = screen.getAllByLabelText('Move down')
    await user.click(moveDownButtons[0])

    await waitFor(() => {
      const puts = mockFetch.mock.calls.filter((call) => call[1]?.method === 'PUT')
      expect(puts.length).toBeGreaterThanOrEqual(2)
      const bodies = puts.map((call) => JSON.parse(call[1].body as string))
      expect(bodies).toContainEqual({ position: 2 })
      expect(bodies).toContainEqual({ position: 1 })
    })
  })
})
