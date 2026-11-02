import { render, screen, waitFor, within } from '@testing-library/react'
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

type ChildItem = {
  id: number
  text: string
  status: 'planned' | 'in_progress' | 'done' | 'cancelled' | 'deferred'
  projectScope: 'work' | 'personal'
  priority: 'high' | 'normal' | 'low'
  isImportant: boolean
  isUrgent: boolean
  weekPeriodStart: string
  weekPeriodEnd: string
  fulfillmentCount: number
  commentCount: number
}

function makeChild(overrides: Partial<ChildItem> = {}): ChildItem {
  return {
    id: 21,
    text: 'Week child',
    status: 'planned',
    projectScope: 'work',
    priority: 'normal',
    isImportant: false,
    isUrgent: false,
    weekPeriodStart: '2026-10-12',
    weekPeriodEnd: '2026-10-18',
    fulfillmentCount: 0,
    commentCount: 0,
    ...overrides,
  }
}

/**
 * Route fetch calls by URL + method. GET /api/plans returns the given week
 * items; GET /api/plans?scope=month returns the month items (when the manager
 * itself is in month scope) or the parent options (week scope).
 */
function setupApi(options: {
  items?: Array<PeriodPlanItem & { fulfillmentCount?: number; commentCount?: number }>
  parentItems?: PeriodPlanItem[]
  monthItems?: Array<PeriodPlanItem & {
    fulfillmentCount?: number
    commentCount?: number
    directFulfillmentCount?: number
    indirectFulfillmentCount?: number
    childItems?: ChildItem[]
  }>
  plan?: { id: number } | null
}) {
  const { items = [], parentItems = [], monthItems = parentItems, plan = null } = options
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('scope=month')) {
      return okJson({ plan: monthItems.length > 0 ? { id: 2 } : null, items: monthItems })
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

  it('expands the comments of the deep-linked item', async () => {
    setupApi({
      items: [
        makeItem({ id: 1, text: 'Other item', position: 1 }),
        makeItem({ id: 2, text: 'Located item', position: 2 }),
      ],
    })
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/plan-items/2/comments')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            comments: [
              {
                id: 55,
                planItemId: 2,
                content: 'Located comment',
                author: null,
                createdAt: '2026-10-14T09:00:00.000Z',
              },
            ],
          }),
        })
      }
      return baseImplementation(input, init)
    })

    const { container } = render(<PeriodPlanManager initialItemId={2} />)

    expect(await screen.findByText('Located comment')).toBeInTheDocument()
    expect(container.querySelector('.reference-highlight')).not.toBeNull()
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

  it('renders items in the priority-grouped order returned by the API', async () => {
    setupApi({
      items: [
        makeItem({ id: 1, text: 'High item', priority: 'high', position: 5 }),
        makeItem({ id: 2, text: 'Normal item', priority: 'normal', position: 1 }),
        makeItem({ id: 3, text: 'Low item', priority: 'low', position: 2 }),
      ],
    })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('High item')).toBeInTheDocument())

    const renderedOrder = screen
      .getAllByText(/^(High|Normal|Low) item$/)
      .map((element) => element.textContent)
    expect(renderedOrder).toEqual(['High item', 'Normal item', 'Low item'])
  })

  it('saves a priority change without touching position and refreshes the list', async () => {
    const user = userEvent.setup()
    setupApi({ items: [makeItem({ id: 3, text: 'Do it', position: 2 })] })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Do it')).toBeInTheDocument())

    const weekPlanFetchCount = () =>
      mockFetch.mock.calls.filter(
        (call) =>
          (call[1]?.method ?? 'GET') === 'GET' &&
          String(call[0]).startsWith('/api/plans?scope=week'),
      ).length
    const fetchesBefore = weekPlanFetchCount()

    await user.selectOptions(screen.getByLabelText('Priority'), 'high')

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/3',
      )
      expect(putCall).toBeDefined()
      expect(JSON.parse(putCall![1].body as string)).toEqual({ priority: 'high' })
    })

    await waitFor(() => expect(weekPlanFetchCount()).toBeGreaterThan(fetchesBefore))
  })

  it('updates plan item flags without refetching the priority-ordered list', async () => {
    const user = userEvent.setup()
    setupApi({ items: [makeItem({ id: 3, text: 'Do it', position: 2 })] })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Do it')).toBeInTheDocument())

    const weekPlanFetchCount = () =>
      mockFetch.mock.calls.filter(
        (call) =>
          (call[1]?.method ?? 'GET') === 'GET' &&
          String(call[0]).startsWith('/api/plans?scope=week'),
      ).length
    const fetchesBefore = weekPlanFetchCount()

    await user.click(screen.getByRole('button', { name: 'Toggle plan item important flag' }))
    await user.click(screen.getByRole('button', { name: 'Toggle plan item urgent flag' }))

    await waitFor(() => {
      const bodies = mockFetch.mock.calls
        .filter((call) => call[1]?.method === 'PUT')
        .map((call) => JSON.parse(call[1].body as string))
      expect(bodies).toContainEqual({ isImportant: true })
      expect(bodies).toContainEqual({ isUrgent: true })
    })

    // Flags carry no ordering weight, so no list refetch is needed.
    expect(weekPlanFetchCount()).toBe(fetchesBefore)
  })

  it('displays a low priority item that is both important and urgent', async () => {
    setupApi({
      items: [
        makeItem({
          id: 4,
          text: 'Quadrant item',
          priority: 'low',
          isImportant: true,
          isUrgent: true,
        }),
      ],
    })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Quadrant item')).toBeInTheDocument())

    expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('low')
    expect(screen.getByRole('button', { name: 'Toggle plan item important flag' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Toggle plan item urgent flag' }))
      .toHaveAttribute('aria-pressed', 'true')
    // One occurrence in the toggle control, one in the badge.
    expect(screen.getAllByText('Important')).toHaveLength(2)
    expect(screen.getAllByText('Urgent')).toHaveLength(2)
  })

  it('deletes an item only after confirming in the dialog', async () => {    const user = userEvent.setup()
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

  it('shows and expands aggregated comments on month-scope items', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        { ...makeItem({ id: 12, text: 'Month goal', periodPlanId: 2 }), commentCount: 1 },
      ],
    })
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/plan-items/12/comments')) {
        return okJson({
          comments: [
            {
              id: 301,
              planItemId: 11,
              content: 'Month-side decision',
              author: null,
              createdAt: '2026-10-04T09:00:00.000Z',
              sourcePeriod: {
                scope: 'month',
                periodStart: '2026-09-01',
                periodEnd: '2026-09-30',
                monthKey: '2026-09',
                label: 'Month 2026-09',
              },
            },
          ],
          commentCount: 1,
        })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    expect(screen.getByText('1 comments')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Toggle comments'))

    expect(await screen.findByText('Month-side decision')).toBeInTheDocument()
    expect(screen.getByText('Month 2026-09')).toBeInTheDocument()
  })

  it('renders the month review tree with attached week items in API order', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          fulfillmentCount: 3,
          directFulfillmentCount: 1,
          indirectFulfillmentCount: 2,
          commentCount: 1,
          childItems: [
            makeChild({ id: 21, text: 'High child', priority: 'high' }),
            makeChild({
              id: 22,
              text: 'Normal child',
              priority: 'normal',
              weekPeriodStart: '2026-10-26',
              weekPeriodEnd: '2026-11-01',
            }),
          ],
        },
      ],
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    expect(screen.getByText('3 fulfilled')).toBeInTheDocument()
    expect(screen.getByText('1 direct · 2 indirect')).toBeInTheDocument()
    expect(screen.getByText('1 comments')).toBeInTheDocument()

    // Children are eager in the payload but hidden until the row expands.
    expect(screen.queryByText('High child')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))

    const rendered = screen
      .getAllByText(/^(High|Normal) child$/)
      .map((element) => element.textContent)
    expect(rendered).toEqual(['High child', 'Normal child'])
  })

  it('lazily loads an attached week item’s fulfilling events inside the month tab', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          fulfillmentCount: 1,
          directFulfillmentCount: 0,
          indirectFulfillmentCount: 1,
          childItems: [makeChild({ id: 21, text: 'Week child', fulfillmentCount: 1 })],
        },
      ],
    })
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/plan-items/21/fulfillment')) {
        return okJson({
          events: [
            {
              id: 31,
              content: 'Landed the migration',
              eventTime: '2026-10-14T09:00:00.000Z',
              isManual: true,
            },
          ],
        })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))

    // Expanding the month row alone must not load the child's events.
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/plan-items/21/fulfillment'),
      expect.anything(),
    )

    const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
    await user.click(childRow.getByLabelText('Toggle fulfillment events'))

    expect(await screen.findByText('Landed the migration')).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/plan-items/21/fulfillment'),
      expect.anything(),
    )
  })

  it('deep-links an attached week item to its week view', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          childItems: [makeChild({ id: 21, text: 'Week child' })],
        },
      ],
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))

    expect(screen.getByRole('link', { name: 'Week 2026-10-12 - 2026-10-18' }))
      .toHaveAttribute('href', '/plans?scope=week&start=2026-10-12')
  })

  it('keeps attached week items visible after editing a month item', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          childItems: [makeChild({ id: 21, text: 'Week child' })],
        },
      ],
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))
    expect(screen.getByText('Week child')).toBeInTheDocument()

    // The real PUT echoes the same row; mirror that so the row keeps its key
    // (and therefore its expanded state) after the edit.
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(input) === '/api/plan-items/10') {
        return okJson(makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }))
      }
      return baseImplementation(input, init)
    })

    await user.selectOptions(screen.getByLabelText('Status'), 'done')

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/10',
        ),
      ).toBe(true)
    })
    expect(screen.getByText('Week child')).toBeInTheDocument()
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

  const groupedItems = () => [
    makeItem({ id: 1, text: 'High item', priority: 'high', position: 1 }),
    makeItem({ id: 2, text: 'Normal A', priority: 'normal', position: 2 }),
    makeItem({ id: 3, text: 'Normal B', priority: 'normal', position: 3 }),
    makeItem({ id: 4, text: 'Low item', priority: 'low', position: 4 }),
  ]

  it('moves down within the same priority group by swapping positions only', async () => {
    const user = userEvent.setup()
    setupApi({ items: groupedItems() })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Normal A')).toBeInTheDocument())

    // Row order: high, Normal A (normal group head), Normal B, low.
    await user.click(screen.getAllByLabelText('Move down')[1])

    await waitFor(() => {
      const puts = mockFetch.mock.calls.filter(
        (call) => call[1]?.method === 'PUT' && String(call[0]).startsWith('/api/plan-items/')
      )
      expect(puts).toHaveLength(2)
      expect(String(puts[0][0])).toBe('/api/plan-items/2')
      expect(JSON.parse(puts[0][1].body as string)).toEqual({ position: 3 })
      expect(String(puts[1][0])).toBe('/api/plan-items/3')
      expect(JSON.parse(puts[1][1].body as string)).toEqual({ position: 2 })
    })
  })

  it('moves up within the same priority group by swapping positions only', async () => {
    const user = userEvent.setup()
    setupApi({ items: groupedItems() })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Normal B')).toBeInTheDocument())

    // Move Normal B up past Normal A; both stay in the normal group.
    await user.click(screen.getAllByLabelText('Move up')[2])

    await waitFor(() => {
      const puts = mockFetch.mock.calls.filter(
        (call) => call[1]?.method === 'PUT' && String(call[0]).startsWith('/api/plan-items/')
      )
      expect(puts).toHaveLength(2)
      expect(String(puts[0][0])).toBe('/api/plan-items/3')
      expect(JSON.parse(puts[0][1].body as string)).toEqual({ position: 2 })
      expect(String(puts[1][0])).toBe('/api/plan-items/2')
      expect(JSON.parse(puts[1][1].body as string)).toEqual({ position: 3 })
    })
  })

  it('does nothing when the group head moves up or the group tail moves down', async () => {
    const user = userEvent.setup()
    setupApi({ items: groupedItems() })
    render(<PeriodPlanManager />)

    await waitFor(() => expect(screen.getByText('Normal A')).toBeInTheDocument())

    const moveUps = screen.getAllByLabelText('Move up')
    const moveDowns = screen.getAllByLabelText('Move down')
    // The normal group head cannot move up, and its tail cannot move down.
    expect(moveUps[1]).toBeDisabled()
    expect(moveDowns[2]).toBeDisabled()

    await user.click(moveUps[1])
    await user.click(moveDowns[2])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false)
  })
})
