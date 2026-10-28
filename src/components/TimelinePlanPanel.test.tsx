import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TimelinePlanPanel } from './TimelinePlanPanel'
import type { PeriodPlanItem, PeriodPlanItemStatus, ProjectScope } from '@/lib/db/schema'

const mockFetch = vi.fn()
global.fetch = mockFetch

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

function makeItem(
  id: number,
  text: string,
  status: PeriodPlanItemStatus,
  projectScope: ProjectScope = 'work',
): PeriodPlanItem {
  return {
    id,
    periodPlanId: 1,
    text,
    status,
    projectScope,
    parentItemId: null,
    deferredFromItemId: null,
    position: id,
    createdAt: new Date('2026-10-12'),
    updatedAt: new Date('2026-10-12'),
  }
}

function planResponse(items: PeriodPlanItem[]) {
  return {
    ok: true,
    json: () => Promise.resolve({
      plan: items.length > 0
        ? { id: 1, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18' }
        : null,
      items,
    }),
  }
}

const ALL_STATUS_ITEMS: PeriodPlanItem[] = [
  makeItem(1, 'Planned work', 'planned', 'work'),
  makeItem(2, 'In progress personal', 'in_progress', 'personal'),
  makeItem(3, 'Done work', 'done', 'work'),
  makeItem(4, 'Cancelled personal', 'cancelled', 'personal'),
  makeItem(5, 'Deferred work', 'deferred', 'work'),
]

async function renderWith(items: PeriodPlanItem[]) {
  mockFetch.mockResolvedValueOnce(planResponse(items))
  const user = userEvent.setup()
  const view = render(<TimelinePlanPanel />)
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  return { user, ...view }
}

describe('TimelinePlanPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders loading state initially', () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // Never resolves

    render(<TimelinePlanPanel />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    // Status filter must not render while loading.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('fetches current week plan on mount', async () => {
    // 固定时钟：组件按本地时区取「今天」（date-fns），断言若另取一次时间，
    // 在 UTC/本地错位窗口与跨午夜时会拿到不同日期（曾致 flake）。
    vi.setSystemTime(new Date('2026-10-15T12:00:00'))
    const dateStr = '2026-10-15'

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ plan: null, items: [] }),
    })

    render(<TimelinePlanPanel />)

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

    render(<TimelinePlanPanel />)

    await waitFor(() => {
      expect(screen.getByText(/no plan yet/i)).toBeInTheDocument()
    })

    expect(screen.getByRole('link', { name: /create plan/i })).toBeInTheDocument()
  })

  it('hides the status filter when the week is genuinely empty', async () => {
    await renderWith([])

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /filter plan items/i })).not.toBeInTheDocument()
  })

  it('shows all five status options in shared order', async () => {
    await renderWith(ALL_STATUS_ITEMS)

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(5)
    expect(checkboxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'Planned',
      'In Progress',
      'Done',
      'Cancelled',
      'Deferred',
    ])
  })

  it('defaults to planned + in progress only', async () => {
    await renderWith(ALL_STATUS_ITEMS)

    expect(screen.getByRole('checkbox', { name: 'Planned' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'In Progress' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Cancelled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Deferred' })).not.toBeChecked()

    expect(screen.getByText('Planned work')).toBeInTheDocument()
    expect(screen.getByText('In progress personal')).toBeInTheDocument()
    expect(screen.queryByText('Done work')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelled personal')).not.toBeInTheDocument()
    expect(screen.queryByText('Deferred work')).not.toBeInTheDocument()
  })

  it('adds a status to the filter when its checkbox is selected', async () => {
    const { user } = await renderWith(ALL_STATUS_ITEMS)

    await user.click(screen.getByRole('checkbox', { name: 'Done' }))

    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked()
    expect(screen.getByText('Done work')).toBeInTheDocument()
    expect(screen.getByText('Planned work')).toBeInTheDocument()
    expect(screen.queryByText('Cancelled personal')).not.toBeInTheDocument()
  })

  it('removes a status from the filter when its checkbox is unselected', async () => {
    const { user } = await renderWith(ALL_STATUS_ITEMS)

    await user.click(screen.getByRole('checkbox', { name: 'Planned' }))

    expect(screen.getByRole('checkbox', { name: 'Planned' })).not.toBeChecked()
    expect(screen.queryByText('Planned work')).not.toBeInTheDocument()
    expect(screen.getByText('In progress personal')).toBeInTheDocument()
  })

  it('treats an all-unchecked selection as showing every status', async () => {
    const { user } = await renderWith(ALL_STATUS_ITEMS)

    for (const label of ['Planned', 'In Progress']) {
      await user.click(screen.getByRole('checkbox', { name: label }))
    }
    expect(screen.getAllByRole('checkbox').every((box) => !box.hasAttribute('aria-checked') || box.getAttribute('aria-checked') === 'false')).toBe(true)

    expect(screen.getByText('Planned work')).toBeInTheDocument()
    expect(screen.getByText('In progress personal')).toBeInTheDocument()
    expect(screen.getByText('Done work')).toBeInTheDocument()
    expect(screen.getByText('Cancelled personal')).toBeInTheDocument()
    expect(screen.getByText('Deferred work')).toBeInTheDocument()
    expect(screen.queryByText(/no plan items match this filter/i)).not.toBeInTheDocument()
  })

  it('shows the filtered-zero message and keeps links when the filter matches nothing', async () => {
    await renderWith([makeItem(3, 'Done work', 'done')])

    expect(screen.getByText(/no plan items match this filter/i)).toBeInTheDocument()
    expect(screen.queryByText(/no plan yet for this week/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /create plan/i })).not.toBeInTheDocument()

    // Filter stays visible so the user can change it.
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
    expect(screen.getByRole('link', { name: /manage plans/i })).toHaveAttribute('href', '/plans')
    expect(screen.getByRole('link', { name: /view all plans/i })).toHaveAttribute('href', '/plans')
  })

  it('preserves the status selection across a refreshKey data refetch', async () => {
    // First response: only a planned item.
    mockFetch.mockResolvedValueOnce(planResponse([makeItem(1, 'Planned item', 'planned')]))
    const user = userEvent.setup()
    const view = render(<TimelinePlanPanel />)
    await waitFor(() => expect(screen.getByText('Planned item')).toBeInTheDocument())

    // Switch the filter from the default planned+in_progress to done-only.
    await user.click(screen.getByRole('checkbox', { name: 'Planned' }))
    await user.click(screen.getByRole('checkbox', { name: 'In Progress' }))
    await user.click(screen.getByRole('checkbox', { name: 'Done' }))

    expect(screen.getByRole('checkbox', { name: 'Planned' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'In Progress' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked()

    // Second response: only a done item — distinct from the first so the
    // assertions cannot pass without the selection being preserved through
    // the second data application.
    mockFetch.mockResolvedValueOnce(planResponse([makeItem(2, 'Done item', 'done')]))
    view.rerender(<TimelinePlanPanel refreshKey={1} />)

    await waitFor(() => expect(screen.getByText('Done item')).toBeInTheDocument())

    // Selection must still be done-only after the refetch applied the new data.
    expect(screen.getByRole('checkbox', { name: 'Planned' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'In Progress' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked()
    // The old planned item is gone with the previous data and must not leak back in.
    expect(screen.queryByText('Planned item')).not.toBeInTheDocument()
  })

  it('makes no extra server requests when the filter changes', async () => {
    const { user } = await renderWith(ALL_STATUS_ITEMS)
    const callsAfterLoad = mockFetch.mock.calls.length

    await user.click(screen.getByRole('checkbox', { name: 'Done' }))
    await user.click(screen.getByRole('checkbox', { name: 'Cancelled' }))

    expect(mockFetch.mock.calls.length).toBe(callsAfterLoad)
  })

  it('renders the %<id> badge as a separate element at the row start', async () => {
    await renderWith([makeItem(42, 'Review PR', 'in_progress')])

    const idBadge = screen.getByText('%42')
    const textCell = screen.getByText('Review PR')

    // The id lives in its own element, not merged into the plan text.
    expect(textCell).not.toContainElement(idBadge)
    expect(idBadge).not.toContainElement(textCell)

    const row = idBadge.closest('li')
    expect(row).not.toBeNull()
    expect(row!.firstElementChild).toBe(idBadge)
  })

  it('keeps the plan text untruncated and places each badge inline after it', async () => {
    const longText = 'A very long plan item description that must wrap naturally instead of being truncated'
    await renderWith([makeItem(7, longText, 'planned')])

    const textCell = screen.getByText(longText)
    expect(textCell).not.toHaveClass('truncate')
    expect(textCell).not.toHaveClass('line-clamp-1')

    // Each metadata badge is its own inline-flow child of the text container,
    // not nested in a wrapper that would force them to wrap as a pair.
    const statusBadge = screen.getByRole('img', { name: 'Status: Planned' })
    const scopeBadge = screen.getByRole('img', { name: 'Project scope: Work' })
    expect(statusBadge.parentElement).toBe(textCell)
    expect(scopeBadge.parentElement).toBe(textCell)
    expect(statusBadge.nextElementSibling).toBe(scopeBadge)
  })

  it('exposes icon-only status and scope badges with accessible names and no visible text', async () => {
    await renderWith([makeItem(1, 'Planned work', 'planned', 'work'), makeItem(2, 'Personal item', 'in_progress', 'personal')])

    const workRow = screen.getByText('Planned work').closest('li')!
    expect(within(workRow).queryByText(/^work$/i)).not.toBeInTheDocument()
    expect(within(workRow).queryByText(/^planned$/i)).not.toBeInTheDocument()

    // role="img" with aria-label is the name-bearing contract we test.
    const statusBadge = within(workRow).getByRole('img', { name: 'Status: Planned' })
    const scopeBadge = within(workRow).getByRole('img', { name: 'Project scope: Work' })
    expect(statusBadge).toHaveAttribute('tabindex', '0')
    expect(scopeBadge).toHaveAttribute('tabindex', '0')
    // Icons are decorative and carry no text content.
    expect(statusBadge).toHaveTextContent('')
    expect(scopeBadge).toHaveTextContent('')

    const personalRow = screen.getByText('Personal item').closest('li')!
    expect(within(personalRow).getByRole('img', { name: 'Status: In Progress' })).toBeInTheDocument()
    expect(within(personalRow).getByRole('img', { name: 'Project scope: Personal' })).toBeInTheDocument()
    expect(within(personalRow).queryByText(/^personal$/i)).not.toBeInTheDocument()
  })

  it('provides link to /plans page', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        plan: { id: 1, scope: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18' },
        items: [],
      }),
    })

    render(<TimelinePlanPanel />)

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

    render(<TimelinePlanPanel />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/network error/i)).toBeInTheDocument()
    })

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
