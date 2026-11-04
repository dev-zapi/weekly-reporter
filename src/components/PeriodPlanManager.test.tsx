import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeriodPlanManager } from './PeriodPlanManager'
import type { PlanInheritedChildGroup } from './PeriodPlanItemRow'
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

type AttachCandidateItem = Omit<ChildItem, 'weekPeriodStart' | 'weekPeriodEnd' | 'fulfillmentCount' | 'commentCount'>
type AttachCandidateWeek = {
  periodStart: string
  periodEnd: string
  items: AttachCandidateItem[]
}

function makeCandidate(overrides: Partial<AttachCandidateItem> = {}): AttachCandidateItem {
  return {
    id: 31,
    text: 'Unparented week item',
    status: 'planned',
    projectScope: 'work',
    priority: 'normal',
    isImportant: false,
    isUrgent: false,
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
    inheritedChildGroups?: PlanInheritedChildGroup[]
  }>
  plan?: { id: number } | null
  attachCandidates?: AttachCandidateWeek[]
}) {
  const {
    items = [],
    parentItems = [],
    monthItems = parentItems,
    plan = null,
    attachCandidates = [],
  } = options
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('scope=month')) {
      return okJson({
        plan: monthItems.length > 0 ? { id: 2 } : null,
        items: monthItems,
        attachCandidates,
      })
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
      // The real endpoint echoes the updated row, including its id.
      const id = Number(url.split('/').pop())
      return okJson(makeItem({ id }))
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
      expect(screen.getByLabelText('Parent month item for %1')).toBeInTheDocument()
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

    await waitFor(() => expect(screen.getByLabelText('Parent month item for %1')).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText('Parent month item for %1'), '50')

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

    await user.selectOptions(screen.getByLabelText('Status for %3'), 'done')

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

    await user.selectOptions(screen.getByLabelText('Priority for %3'), 'high')

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

    expect((screen.getByLabelText('Priority for %4') as HTMLSelectElement).value).toBe('low')
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

  it('shows and expands comment sections on attached week items inside the month tab', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          childItems: [makeChild({ id: 21, text: 'Week child', commentCount: 2 })],
        },
      ],
    })
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/plan-items/21/comments')) {
        return okJson({
          comments: [
            {
              id: 401,
              planItemId: 3,
              content: 'Ancestor week blocker',
              author: null,
              createdAt: '2026-10-06T09:00:00.000Z',
              sourcePeriod: {
                scope: 'week',
                periodStart: '2026-10-05',
                periodEnd: '2026-10-11',
                monthKey: null,
                label: 'Week 2026-10-05 - 2026-10-11',
              },
            },
            {
              id: 402,
              planItemId: 21,
              content: 'Own week note',
              author: null,
              createdAt: '2026-10-13T09:00:00.000Z',
            },
          ],
        })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))

    // The composed count badges the child before anything loads.
    const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
    expect(childRow.getByText('2 comments')).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalledWith(
      '/api/plan-items/21/comments',
      expect.anything(),
    )

    await user.click(childRow.getByLabelText('Toggle comments'))

    expect(mockFetch).toHaveBeenCalledWith('/api/plan-items/21/comments', expect.anything())
    expect(await childRow.findByText('Ancestor week blocker')).toBeInTheDocument()
    expect(childRow.getByText('Own week note')).toBeInTheDocument()
    expect(childRow.getByText('Week 2026-10-05 - 2026-10-11')).toBeInTheDocument()
  })

  it('keeps a week child’s badge fresh after commenting and collapsing its group', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          childItems: [makeChild({ id: 21, text: 'Week child', commentCount: 0 })],
        },
      ],
    })
    const createdComment = {
      id: 501,
      planItemId: 21,
      content: 'Fresh note',
      author: null,
      createdAt: '2026-10-14T09:00:00.000Z',
    }
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/plan-items/21/comments')) {
        if (init?.method === 'POST') {
          return Promise.resolve({ ok: true, status: 201, json: async () => createdComment })
        }
        // The section opens empty; only the POST brings the comment in.
        return okJson({ comments: [] })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))

    const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
    await user.click(childRow.getByLabelText('Toggle comments'))
    await user.type(await childRow.findByLabelText('New comment'), 'Fresh note{Enter}')

    expect(await childRow.findByText('Fresh note')).toBeInTheDocument()
    expect(childRow.getByText('1 comments')).toBeInTheDocument()

    // Collapsing the group unmounts the child row; the remounted row must not
    // fall back to the stale composed count from the original payload.
    await user.click(screen.getByLabelText('Toggle attached week items'))
    await user.click(screen.getByLabelText('Toggle attached week items'))

    const remountedRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
    expect(remountedRow.getByText('1 comments')).toBeInTheDocument()
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

    await user.selectOptions(screen.getAllByLabelText(/^Status for %/)[0], 'done')

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/10',
        ),
      ).toBe(true)
    })
    expect(screen.getByText('Week child')).toBeInTheDocument()
  })

  it('keeps inherited week items visible after an inline edit that does not refetch', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        {
          ...makeItem({ id: 10, text: 'Deferred month goal', periodPlanId: 3 }),
          fulfillmentCount: 1,
          directFulfillmentCount: 0,
          indirectFulfillmentCount: 1,
          childItems: [],
          inheritedChildGroups: [
            {
              ancestorItemId: 5,
              ancestorMonth: '2026-09',
              items: [
                {
                  id: 21,
                  text: 'Earlier week child',
                  status: 'planned',
                  projectScope: 'work',
                  priority: 'normal',
                  isImportant: false,
                  isUrgent: false,
                  weekPeriodStart: '2026-09-14',
                  weekPeriodEnd: '2026-09-20',
                  fulfillmentCount: 1,
                },
              ],
            },
          ],
        },
      ],
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Deferred month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle inherited week items'))
    expect(screen.getByText('Earlier week child')).toBeInTheDocument()

    // The PUT response is the bare item row and a status edit does not refetch,
    // so the read-only inherited section must survive the inline merge.
    await user.selectOptions(screen.getByLabelText('Status for %10'), 'done')

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/10',
      )
      expect(putCall).toBeDefined()
      expect(JSON.parse(putCall![1].body as string)).toEqual({ status: 'done' })
    })
    expect(screen.getByText('Earlier week child')).toBeInTheDocument()
    expect(screen.getByLabelText('Toggle inherited week items')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
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

  it('offers attach candidates grouped by their week on monthly items', async () => {
    const user = userEvent.setup()
    setupApi({
      monthItems: [
        { ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }), childItems: [] },
      ],
      attachCandidates: [
        {
          periodStart: '2026-10-12',
          periodEnd: '2026-10-18',
          items: [
            makeCandidate({ id: 31, text: 'High unparented', priority: 'high' }),
            makeCandidate({ id: 32, text: 'Normal unparented', priority: 'normal' }),
          ],
        },
        {
          periodStart: '2026-10-26',
          periodEnd: '2026-11-01',
          items: [makeCandidate({ id: 33, text: 'Late unparented', priority: 'low' })],
        },
      ],
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Attach week item'))

    const dialog = within(await screen.findByRole('dialog'))
    const week3 = within(dialog.getByRole('group', { name: 'Week 2026-10-12 - 2026-10-18' }))
    const week5 = within(dialog.getByRole('group', { name: 'Week 2026-10-26 - 2026-11-01' }))
    expect(
      week3.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['High unparented', 'Normal unparented'])
    expect(week5.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Late unparented',
    ])
    // Candidates outside the month payload are never offered.
    expect(dialog.queryByText(/september/i)).not.toBeInTheDocument()
  })

  it('attaches a week item through the update endpoint and refreshes the tree in place', async () => {
    const user = userEvent.setup()
    let attached = false

    setupApi({})
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'PUT' && url === '/api/plan-items/31') {
        attached = true
        return okJson(makeItem({ id: 31 }))
      }
      if (method === 'GET' && url.includes('scope=month')) {
        return okJson({
          plan: { id: 2 },
          items: [
            {
              ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
              fulfillmentCount: attached ? 1 : 0,
              directFulfillmentCount: 0,
              indirectFulfillmentCount: attached ? 1 : 0,
              childItems: attached
                ? [makeChild({ id: 31, text: 'Unparented week item', fulfillmentCount: 1 })]
                : [],
            },
          ],
          attachCandidates: attached
            ? []
            : [
                {
                  periodStart: '2026-10-12',
                  periodEnd: '2026-10-18',
                  items: [makeCandidate({ id: 31, text: 'Unparented week item' })],
                },
              ],
        })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    expect(screen.getByText('0 fulfilled')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Attach week item'))
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Unparented week item' }))

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/31',
      )
      expect(put).toBeDefined()
      expect(JSON.parse(put![1].body as string)).toEqual({ parentItemId: 10 })
    })

    // The month payload is refetched; the candidate is now an attached child,
    // and the composed badge reflects it. No separate write surface is used.
    await waitFor(() => expect(screen.getByText('1 fulfilled')).toBeInTheDocument())
    expect(screen.queryByText('Unparented week item')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))
    expect(screen.getByText('Unparented week item')).toBeInTheDocument()
    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false)

    // No navigation: every plans list read stayed in month scope.
    const planReads = mockFetch.mock.calls.filter(
      (call) =>
        (call[1]?.method ?? 'GET') === 'GET' &&
        String(call[0]).startsWith('/api/plans'),
    )
    expect(planReads.length).toBeGreaterThan(1)
    expect(planReads.every((call) => String(call[0]).includes('scope=month'))).toBe(true)
  })

  it('detaches an attached week item from its child row', async () => {
    const user = userEvent.setup()
    let detached = false

    setupApi({})
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'PUT' && url === '/api/plan-items/21') {
        detached = true
        return okJson(makeItem({ id: 21 }))
      }
      if (method === 'GET' && url.includes('scope=month')) {
        return okJson({
          plan: { id: 2 },
          items: [
            {
              ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
              fulfillmentCount: 0,
              directFulfillmentCount: 0,
              indirectFulfillmentCount: 0,
              childItems: detached ? [] : [makeChild({ id: 21, text: 'Week child' })],
            },
          ],
          attachCandidates: detached
            ? [
                {
                  periodStart: '2026-10-12',
                  periodEnd: '2026-10-18',
                  items: [makeCandidate({ id: 21, text: 'Week child' })],
                },
              ]
            : [],
        })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Toggle attached week items'))

    const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
    const parentSelect = childRow.getByLabelText('Parent month item for %21') as HTMLSelectElement
    expect(parentSelect.value).toBe('10')

    await user.selectOptions(parentSelect, '')

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/21',
      )
      expect(put).toBeDefined()
      expect(JSON.parse(put![1].body as string)).toEqual({ parentItemId: null })
    })

    // The child left the tree and returned to the attach candidates.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Week item Week child' })).not.toBeInTheDocument(),
    )
    await user.click(screen.getByLabelText('Attach week item'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Week child' })).toBeInTheDocument()
  })

  it('re-parents an attached week item to another monthly item', async () => {
    const user = userEvent.setup()
    let reParented = false

    setupApi({})
    const baseImplementation = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'PUT' && url === '/api/plan-items/21') {
        reParented = true
        return okJson(makeItem({ id: 21 }))
      }
      if (method === 'GET' && url.includes('scope=month')) {
        return okJson({
          plan: { id: 2 },
          items: [
            {
              ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
              childItems: reParented ? [] : [makeChild({ id: 21, text: 'Week child' })],
            },
            {
              ...makeItem({ id: 11, text: 'Other goal', periodPlanId: 2, position: 2 }),
              childItems: reParented ? [makeChild({ id: 21, text: 'Week child' })] : [],
            },
          ],
          attachCandidates: [],
        })
      }
      return baseImplementation(input, init)
    })

    render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

    expect(await screen.findByText('Month goal')).toBeInTheDocument()
    const childTogglesBefore = screen.getAllByLabelText('Toggle attached week items')
    // Month goal owns the only child.
    expect(childTogglesBefore[0]).toHaveTextContent('Attached week items (1)')
    expect(childTogglesBefore[1]).toHaveTextContent('Attached week items (0)')

    await user.click(childTogglesBefore[0])
    const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
    const parentSelect = childRow.getByLabelText('Parent month item for %21') as HTMLSelectElement
    expect(parentSelect.value).toBe('10')
    // Re-parent targets are the month's own items; cross-month links are never offered.
    expect(within(parentSelect).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No month parent',
      'Month goal',
      'Other goal',
    ])

    await user.selectOptions(parentSelect, '11')

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(
        (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/21',
      )
      expect(put).toBeDefined()
      expect(JSON.parse(put![1].body as string)).toEqual({ parentItemId: 11 })
    })

    // The refreshed tree moves the child under the new monthly item.
    await waitFor(() => {
      const toggles = screen.getAllByLabelText('Toggle attached week items')
      expect(toggles[0]).toHaveTextContent('Attached week items (0)')
      expect(toggles[1]).toHaveTextContent('Attached week items (1)')
    })
    await user.click(screen.getAllByLabelText('Toggle attached week items')[1])
    expect(screen.getByText('Week child')).toBeInTheDocument()
  })

  describe('month review operations', () => {
    function monthReviewItems() {
      return [
        {
          ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
          fulfillmentCount: 0,
          directFulfillmentCount: 0,
          indirectFulfillmentCount: 0,
          childItems: [
            makeChild({ id: 21, text: 'Week child' }),
          ],
        },
      ]
    }

    function monthFetchCount() {
      return mockFetch.mock.calls.filter(
        (call) =>
          (call[1]?.method ?? 'GET') === 'GET' &&
          String(call[0]).includes('/api/plans?scope=month'),
      ).length
    }

    async function expandAttachedWeekItems() {
      const user = userEvent.setup()
      await user.click(screen.getByLabelText('Toggle attached week items'))
      return user
    }

    it('updates an attached week item status through the API and keeps the tree', async () => {
      setupApi({ monthItems: monthReviewItems() })
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()
      const user = await expandAttachedWeekItems()

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.selectOptions(childRow.getByLabelText('Status for %21'), 'done')

      await waitFor(() => {
        const putCall = mockFetch.mock.calls.find(
          (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/21',
        )
        expect(putCall).toBeDefined()
        expect(JSON.parse(putCall![1].body as string)).toEqual({ status: 'done' })
      })
      // The attached child stays in the tree after the inline edit.
      expect(screen.getByRole('link', { name: 'Week 2026-10-12 - 2026-10-18' })).toBeInTheDocument()
    })

    it('changes an attached week item priority and refetches the ordered tree', async () => {
      setupApi({ monthItems: monthReviewItems() })
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()
      const user = await expandAttachedWeekItems()
      const fetchesBefore = monthFetchCount()

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.selectOptions(childRow.getByLabelText('Priority for %21'), 'high')

      await waitFor(() => {
        const putCall = mockFetch.mock.calls.find(
          (call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/21',
        )
        expect(putCall).toBeDefined()
        expect(JSON.parse(putCall![1].body as string)).toEqual({ priority: 'high' })
      })
      await waitFor(() => expect(monthFetchCount()).toBeGreaterThan(fetchesBefore))
    })

    it('toggles flags on an attached week item without refetching the list', async () => {
      setupApi({ monthItems: monthReviewItems() })
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()
      const user = await expandAttachedWeekItems()
      const fetchesBefore = monthFetchCount()

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByRole('button', { name: 'Toggle plan item important flag' }))
      await user.click(childRow.getByRole('button', { name: 'Toggle plan item urgent flag' }))

      await waitFor(() => {
        const bodies = mockFetch.mock.calls
          .filter((call) => call[1]?.method === 'PUT' && call[0] === '/api/plan-items/21')
          .map((call) => JSON.parse(call[1].body as string))
        expect(bodies).toContainEqual({ isImportant: true })
        expect(bodies).toContainEqual({ isUrgent: true })
      })
      expect(monthFetchCount()).toBe(fetchesBefore)
    })

    it('deletes an attached week item from the month tree', async () => {
      setupApi({ monthItems: monthReviewItems() })
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()
      const user = await expandAttachedWeekItems()

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByLabelText('Delete item'))
      await user.click(await screen.findByRole('button', { name: /^delete$/i }))

      await waitFor(() => {
        expect(
          mockFetch.mock.calls.some(
            (call) => call[1]?.method === 'DELETE' && call[0] === '/api/plan-items/21',
          ),
        ).toBe(true)
      })
      await waitFor(() => {
        expect(
          screen.queryByRole('link', { name: 'Week 2026-10-12 - 2026-10-18' }),
        ).not.toBeInTheDocument()
      })
    })

    it('defers an attached week item and refetches the month review', async () => {
      setupApi({ monthItems: monthReviewItems() })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()
      const user = await expandAttachedWeekItems()
      const fetchesBefore = monthFetchCount()

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByLabelText('Defer to next period'))

      await waitFor(() => {
        expect(
          mockFetch.mock.calls.some(
            (call) => call[1]?.method === 'POST' && call[0] === '/api/plan-items/21/defer',
          ),
        ).toBe(true)
      })
      // Refetching the month review is what surfaces the deferral mirror.
      await waitFor(() => expect(monthFetchCount()).toBeGreaterThan(fetchesBefore))
    })

    it('shows the deferred successor’s mirrored aggregation after deferring a month item', async () => {
      setupApi({
        monthItems: [
          {
            ...makeItem({ id: 10, text: 'Month goal', periodPlanId: 2 }),
            fulfillmentCount: 0,
            directFulfillmentCount: 0,
            indirectFulfillmentCount: 0,
            childItems: [],
          },
        ],
      })
      const baseImplementation = mockFetch.getMockImplementation()!
      let deferred = false
      mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (
          method === 'GET' &&
          url.includes('/api/plans?scope=month') &&
          url.includes('month=2026-11') &&
          deferred
        ) {
          // The successor aggregates the ancestor's and its children's events.
          return okJson({
            plan: { id: 3 },
            items: [
              {
                ...makeItem({ id: 100, text: 'Month goal', periodPlanId: 3 }),
                fulfillmentCount: 3,
                directFulfillmentCount: 0,
                indirectFulfillmentCount: 3,
                childItems: [],
              },
            ],
          })
        }
        if (method === 'POST' && url === '/api/plan-items/10/defer') {
          deferred = true
        }
        return baseImplementation(input, init)
      })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const user = userEvent.setup()
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()
      await user.click(screen.getByLabelText('Defer to next period'))

      await waitFor(() => {
        expect(
          mockFetch.mock.calls.some(
            (call) => call[1]?.method === 'POST' && call[0] === '/api/plan-items/10/defer',
          ),
        ).toBe(true)
      })

      // Reviewing the next month surfaces the mirror rule's aggregation.
      await user.click(screen.getByRole('button', { name: 'Next period' }))
      expect(await screen.findByText('0 direct · 3 indirect')).toBeInTheDocument()
    })

    it('creates a new week item in the chosen week of the month', async () => {
      setupApi({ monthItems: monthReviewItems() })
      const user = userEvent.setup()
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()

      const weekSelect = screen.getByLabelText('Target week') as HTMLSelectElement
      // October 2026's Monday-start weeks attributed to the month. The week
      // starting 2026-09-28 belongs to September and is not offered.
      expect(
        within(weekSelect)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual([
        'Week 2026-10-05 - 2026-10-11',
        'Week 2026-10-12 - 2026-10-18',
        'Week 2026-10-19 - 2026-10-25',
        'Week 2026-10-26 - 2026-11-01',
      ])

      await user.selectOptions(weekSelect, '2026-10-12')
      await user.type(screen.getByLabelText('New week item text'), 'Draft spec')
      await user.click(screen.getByRole('button', { name: 'Add week item' }))

      await waitFor(() => {
        const postCall = mockFetch.mock.calls.find(
          (call) => call[1]?.method === 'POST' && call[0] === '/api/plan-items',
        )
        expect(postCall).toBeDefined()
        expect(JSON.parse(postCall![1].body as string)).toEqual({
          scope: 'week',
          weekStart: '2026-10-12',
          weekEnd: '2026-10-18',
          text: 'Draft spec',
          projectScope: 'work',
        })
      })
      expect((screen.getByLabelText('New week item text') as HTMLInputElement).value).toBe('')
    })

    it('still creates monthly items from the month tab', async () => {
      setupApi({ monthItems: monthReviewItems() })
      const user = userEvent.setup()
      render(<PeriodPlanManager initialScope="month" initialStart="2026-10-01" />)

      expect(await screen.findByText('Month goal')).toBeInTheDocument()

      await user.type(screen.getByPlaceholderText(/add a new plan item/i), 'Monthly goal')
      await user.click(screen.getByRole('button', { name: /^add$/i }))

      await waitFor(() => {
        const postCall = mockFetch.mock.calls.find(
          (call) => call[1]?.method === 'POST' && call[0] === '/api/plan-items',
        )
        expect(postCall).toBeDefined()
        const body = JSON.parse(postCall![1].body as string)
        expect(body.scope).toBe('month')
        expect(body.month).toBe('2026-10')
        expect(body.text).toBe('Monthly goal')
      })
    })
  })
})
