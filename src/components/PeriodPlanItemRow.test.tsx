import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeriodPlanItemRow } from './PeriodPlanItemRow'
import type { AttachCandidateWeek, PlanRowItem } from './PeriodPlanItemRow'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

describe('PeriodPlanItemRow', () => {
  const mockItem = {
    id: 1,
    periodPlanId: 1,
    text: 'Test item',
    status: 'planned' as const,
    priority: 'normal' as const,
    isImportant: false,
    isUrgent: false,
    projectScope: 'work' as const,
    parentItemId: null,
    deferredFromItemId: null,
    position: 1,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  }

  const mockOnUpdate = vi.fn()
  const mockOnDelete = vi.fn()
  const mockOnDefer = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders item text and status', () => {
    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    expect(screen.getByText('Test item')).toBeInTheDocument()
    // Badge and the matching <option> both carry the status label
    expect(screen.getAllByText('Planned').length).toBeGreaterThan(0)
    expect((screen.getByLabelText('Status for %1') as HTMLSelectElement).value).toBe('planned')
  })

  it('labels dense row selects with the item reference', () => {
    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    expect(screen.getByLabelText('Status for %1')).toBeInTheDocument()
    expect(screen.getByLabelText('Priority for %1')).toBeInTheDocument()
    expect(screen.getByLabelText('Project scope for %1')).toBeInTheDocument()
  })

  it('calls onUpdate when status is changed', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const statusSelect = screen.getByLabelText('Status for %1')
    await user.selectOptions(statusSelect, 'done')

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { status: 'done' })
  })

  it('shows the item priority and reports priority changes', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const prioritySelect = screen.getByLabelText('Priority for %1') as HTMLSelectElement
    expect(prioritySelect.value).toBe('normal')

    await user.selectOptions(prioritySelect, 'high')

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { priority: 'high' })
  })

  it('shows plan item important and urgent toggles reflecting stored flags', () => {
    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const importantToggle = screen.getByRole('button', { name: 'Toggle plan item important flag' })
    const urgentToggle = screen.getByRole('button', { name: 'Toggle plan item urgent flag' })

    expect(importantToggle).toHaveAttribute('aria-pressed', 'false')
    expect(urgentToggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports important and urgent flag changes', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Toggle plan item important flag' }))
    await user.click(screen.getByRole('button', { name: 'Toggle plan item urgent flag' }))

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { isImportant: true })
    expect(mockOnUpdate).toHaveBeenCalledWith(1, { isUrgent: true })
  })

  it('turns an active flag off with an explicit false update', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, isImportant: true, isUrgent: true }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const importantToggle = screen.getByRole('button', { name: 'Toggle plan item important flag' })
    expect(importantToggle).toHaveAttribute('aria-pressed', 'true')

    await user.click(importantToggle)

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { isImportant: false })
  })

  it('shows badges for a low priority item that is both important and urgent without changing priority', () => {
    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, priority: 'low', isImportant: true, isUrgent: true }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    // One occurrence in the toggle control, one in the badge.
    expect(screen.getAllByText('Important')).toHaveLength(2)
    expect(screen.getAllByText('Urgent')).toHaveLength(2)
    expect((screen.getByLabelText('Priority for %1') as HTMLSelectElement).value).toBe('low')
    expect(screen.getByRole('button', { name: 'Toggle plan item important flag' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Toggle plan item urgent flag' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onUpdate when project scope is changed', async () => {    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const scopeSelect = screen.getByLabelText('Project scope for %1')
    await user.selectOptions(scopeSelect, 'personal')

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { projectScope: 'personal' })
  })

  it('enters edit mode when clicking text', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const textElement = screen.getByText('Test item')
    await user.click(textElement)

    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('saves edit when clicking save button', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByText('Test item'))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Updated text')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { text: 'Updated text' })
  })

  it('calls onDelete when delete button is clicked and confirmed', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ referrers: [] }) })

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByLabelText('Delete item'))
    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    expect(mockOnDelete).toHaveBeenCalledWith(1)
  })

  it('does not call onDelete when confirmation is cancelled', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ referrers: [] }) })

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByLabelText('Delete item'))
    await user.click(await screen.findByRole('button', { name: /cancel/i }))

    expect(mockOnDelete).not.toHaveBeenCalled()
  })

  it('warns about referring events before deleting a referenced item', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        referrers: [
          { id: 11, content: 'Worked on %1', eventTime: '2026-10-14T09:00:00.000Z' },
        ],
      }),
    })

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByLabelText('Delete item'))

    expect(await screen.findByText('Worked on %1')).toBeInTheDocument()
    expect(screen.getByText(/referenced by 1 event/i)).toBeInTheDocument()
  })

  it('calls onDefer when defer button is clicked and confirmed', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const deferButton = screen.getByLabelText('Defer to next period')
    await user.click(deferButton)

    expect(mockOnDefer).toHaveBeenCalledWith(1)
  })

  it('does not call onDefer when confirmation is cancelled', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const deferButton = screen.getByLabelText('Defer to next period')
    await user.click(deferButton)

    expect(mockOnDefer).not.toHaveBeenCalled()
  })

  it('disables the defer control for items that are not incomplete', () => {
    const statuses = ['done', 'cancelled', 'deferred'] as const

    statuses.forEach((status) => {
      const { unmount } = render(
        <PeriodPlanItemRow
          item={{ ...mockItem, status }}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
          onDefer={mockOnDefer}
        />
      )

      expect(screen.getByLabelText('Defer to next period')).toBeDisabled()
      unmount()
    })
  })

  it('keeps the defer control enabled for planned and in_progress items', () => {
    const statuses = ['planned', 'in_progress'] as const

    statuses.forEach((status) => {
      const { unmount } = render(
        <PeriodPlanItemRow
          item={{ ...mockItem, status }}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
          onDefer={mockOnDefer}
        />
      )

      expect(screen.getByLabelText('Defer to next period')).toBeEnabled()
      unmount()
    })
  })

  it('displays correct status label for each status', () => {
    const statuses = ['planned', 'in_progress', 'done', 'cancelled', 'deferred'] as const
    const labels = ['Planned', 'In Progress', 'Done', 'Cancelled', 'Deferred']

    statuses.forEach((status, index) => {
      const item = { ...mockItem, status }
      const { unmount } = render(
        <PeriodPlanItemRow
          item={item}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
          onDefer={mockOnDefer}
        />
      )

      // Badge and the matching <option> both carry the label
      expect(screen.getAllByText(labels[index]).length).toBeGreaterThan(0)
      expect((screen.getByLabelText('Status for %1') as HTMLSelectElement).value).toBe(status)
      unmount()
    })
  })

  it('shows parent month options and reports parent changes', async () => {
    const user = userEvent.setup()
    const parentOptions = [
      { ...mockItem, id: 50, text: 'Month goal', periodPlanId: 2 },
    ]

    render(
      <PeriodPlanItemRow
        item={mockItem}
        parentOptions={parentOptions}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const parentSelect = screen.getByLabelText('Parent month item for %1')
    await user.selectOptions(parentSelect, '50')

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { parentItemId: 50 })
  })

  it('omits the parent selector when no parent options are given', () => {
    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    expect(screen.queryByLabelText(/^Parent month item for %/)).not.toBeInTheDocument()
  })

  it('always renders the parent selector in week scope, even with no parent options', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, parentItemId: 42 }}
        showParentSelector
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const parentSelect = screen.getByLabelText('Parent month item for %1')
    // Only the clear option remains, so a stale link is always clearable.
    const options = within(parentSelect).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('No month parent')

    await user.selectOptions(parentSelect, '')
    expect(mockOnUpdate).toHaveBeenCalledWith(1, { parentItemId: null })
  })

  it('invokes onMove when the move buttons are clicked', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        canMoveUp
        canMoveDown
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
        onMove={onMove}
      />
    )

    await user.click(screen.getByLabelText('Move up'))
    await user.click(screen.getByLabelText('Move down'))

    expect(onMove).toHaveBeenCalledWith(1, 'up')
    expect(onMove).toHaveBeenCalledWith(1, 'down')
  })

  it('disables move buttons at the list boundaries', () => {
    render(
      <PeriodPlanItemRow
        item={mockItem}
        canMoveUp={false}
        canMoveDown={false}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
        onMove={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Move up')).toBeDisabled()
    expect(screen.getByLabelText('Move down')).toBeDisabled()
  })

  it('shows the item id in %<id> form', () => {
    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, id: 42 }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    expect(screen.getByText('%42')).toBeInTheDocument()
  })

  it('shows the fulfillment count when the API provides one', () => {
    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, fulfillmentCount: 3 }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    expect(screen.getByText(/3 fulfilled/i)).toBeInTheDocument()
  })

  it('does not fetch fulfilling events until the row is expanded', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          { id: 11, content: 'Shipped the feature', eventTime: '2026-10-14T09:00:00.000Z', isManual: true },
        ],
      }),
    })

    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, id: 7 }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    expect(mockFetch).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText('Toggle fulfillment events'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/plan-items/7/fulfillment'),
        expect.anything(),
      )
    })
    expect(await screen.findByText('Shipped the feature')).toBeInTheDocument()
  })

  it('marks fulfilling events as manual or collected', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          { id: 11, content: 'Manual work', eventTime: '2026-10-14T09:00:00.000Z', isManual: true },
          { id: 12, content: 'Synced work', eventTime: '2026-10-15T09:00:00.000Z', isManual: false },
        ],
      }),
    })

    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, id: 7 }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByLabelText('Toggle fulfillment events'))

    expect(await screen.findByText('Manual work')).toBeInTheDocument()
    expect(screen.getByText('Synced work')).toBeInTheDocument()
    expect(screen.getByText('Manual')).toBeInTheDocument()
    expect(screen.getByText('Collected')).toBeInTheDocument()
  })

  it('shows an empty message when an item has no fulfilling events', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ events: [] }) })

    render(
      <PeriodPlanItemRow
        item={{ ...mockItem, id: 7 }}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    await user.click(screen.getByLabelText('Toggle fulfillment events'))

    expect(await screen.findByText(/no fulfilling events/i)).toBeInTheDocument()
  })

  describe('comments', () => {
    type CommentView = {
      id: number
      planItemId: number
      content: string
      author: string | null
      createdAt: string
      sourcePeriod?: {
        scope: 'week' | 'month'
        periodStart: string
        periodEnd: string
        monthKey: string | null
        label: string
      }
    }

    function mockCommentApi(
      comments: CommentView[],
      eventResponses: Record<number, { status: number; body?: unknown }> = {},
    ) {
      mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        const eventMatch = url.match(/\/api\/events\/(\d+)/)
        if (eventMatch) {
          const eventResponse = eventResponses[Number(eventMatch[1])]
          if (!eventResponse) throw new Error(`Unexpected event fetch: ${url}`)
          return {
            ok: eventResponse.status !== 404,
            status: eventResponse.status,
            json: async () => eventResponse.body,
          }
        }
        if (url.includes('/comments') && method === 'GET') {
          return { ok: true, json: async () => ({ comments }) }
        }
        if (url.includes('/comments') && method === 'POST') {
          const body = JSON.parse(String(init?.body))
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 999,
              planItemId: 7,
              content: body.content,
              author: null,
              createdAt: '2026-10-15T10:00:00.000Z',
            }),
          }
        }
        if (url.includes('/comments') && method === 'DELETE') {
          return { ok: true, json: async () => ({ deleted: true }) }
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })
    }

    function renderRow(itemProps: Record<string, unknown> = {}) {
      return render(
        <PeriodPlanItemRow
          item={{ ...mockItem, id: 7, ...itemProps }}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
          onDefer={mockOnDefer}
        />
      )
    }

    it('shows the comment count badge when the API provides one', () => {
      renderRow({ commentCount: 2 })

      expect(screen.getByText('2 comments')).toBeInTheDocument()
    })

    it('does not fetch comments until the section is expanded', () => {
      renderRow({ commentCount: 1 })

      expect(mockFetch).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Toggle comments')).toBeInTheDocument()
    })

    it('auto-expands, loads and highlights comments when deep-linked', async () => {
      mockCommentApi([
        {
          id: 201,
          planItemId: 7,
          content: 'Deep-linked comment',
          author: null,
          createdAt: '2026-10-14T09:00:00.000Z',
        },
      ])

      const { container } = render(
        <PeriodPlanItemRow
          item={{ ...mockItem, id: 7 }}
          autoExpandComments
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
          onDefer={mockOnDefer}
        />
      )

      expect(await screen.findByText('Deep-linked comment')).toBeInTheDocument()
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/plan-items/7/comments',
        expect.anything(),
      )
      expect(container.querySelector('.reference-highlight')).not.toBeNull()
    })

    it('loads and renders comments with author and no edit affordance', async () => {
      const user = userEvent.setup()
      mockCommentApi([
        {
          id: 201,
          planItemId: 7,
          content: 'Earlier blocker',
          author: 'period-plans/claude',
          createdAt: '2026-10-14T09:00:00.000Z',
        },
        {
          id: 202,
          planItemId: 7,
          content: 'User follow-up',
          author: null,
          createdAt: '2026-10-15T09:00:00.000Z',
        },
      ])

      renderRow({ commentCount: 2 })
      await user.click(screen.getByLabelText('Toggle comments'))

      expect(await screen.findByText('Earlier blocker')).toBeInTheDocument()
      expect(screen.getByText('User follow-up')).toBeInTheDocument()
      expect(screen.getByText('period-plans/claude')).toBeInTheDocument()
      expect(screen.getByText('用户')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /edit comment/i })).not.toBeInTheDocument()
    })

    it('marks deferral-chain ancestor comments with their source period and keeps them non-deletable', async () => {
      const user = userEvent.setup()
      mockCommentApi([
        {
          id: 201,
          planItemId: 3,
          content: 'Ancestor blocker',
          author: 'period-plans/claude',
          createdAt: '2026-10-13T09:00:00.000Z',
          sourcePeriod: {
            scope: 'week',
            periodStart: '2026-10-05',
            periodEnd: '2026-10-11',
            monthKey: null,
            label: 'Week 2026-10-05 - 2026-10-11',
          },
        },
        {
          id: 202,
          planItemId: 7,
          content: 'Own follow-up',
          author: null,
          createdAt: '2026-10-15T09:00:00.000Z',
          sourcePeriod: {
            scope: 'week',
            periodStart: '2026-10-12',
            periodEnd: '2026-10-18',
            monthKey: null,
            label: 'Week 2026-10-12 - 2026-10-18',
          },
        },
      ])

      renderRow({ commentCount: 2 })
      await user.click(screen.getByLabelText('Toggle comments'))

      expect(await screen.findByText('Ancestor blocker')).toBeInTheDocument()
      expect(screen.getByText('Week 2026-10-05 - 2026-10-11')).toBeInTheDocument()
      // The owning item's period is not repeated on its own comments.
      expect(screen.queryByText('Week 2026-10-12 - 2026-10-18')).not.toBeInTheDocument()
      // Ancestor comments are read-only from the successor item.
      expect(screen.queryByLabelText('Delete comment 201')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Delete comment 202')).toBeInTheDocument()
    })

    it('keeps the aggregated badge equal to the comments shown when expanded', async () => {
      const user = userEvent.setup()
      mockCommentApi([
        {
          id: 201,
          planItemId: 3,
          content: 'Ancestor blocker',
          author: null,
          createdAt: '2026-10-13T09:00:00.000Z',
          sourcePeriod: {
            scope: 'week',
            periodStart: '2026-10-05',
            periodEnd: '2026-10-11',
            monthKey: null,
            label: 'Week 2026-10-05 - 2026-10-11',
          },
        },
        {
          id: 202,
          planItemId: 7,
          content: 'Own follow-up',
          author: null,
          createdAt: '2026-10-15T09:00:00.000Z',
        },
        {
          id: 203,
          planItemId: 7,
          content: 'Another own note',
          author: null,
          createdAt: '2026-10-16T09:00:00.000Z',
        },
      ])

      renderRow({ commentCount: 3 })
      expect(screen.getByText('3 comments')).toBeInTheDocument()

      await user.click(screen.getByLabelText('Toggle comments'))

      await screen.findByText('Ancestor blocker')
      const list = screen.getByRole('list')
      expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    })

    it('shows an empty message when an item has no comments', async () => {
      const user = userEvent.setup()
      mockCommentApi([])

      renderRow({ commentCount: 0 })
      await user.click(screen.getByLabelText('Toggle comments'))

      expect(await screen.findByText(/no comments/i)).toBeInTheDocument()
    })

    it('submits a comment on Enter and renders it immediately as 用户', async () => {
      const user = userEvent.setup()
      mockCommentApi([])

      renderRow({ commentCount: 0 })
      await user.click(screen.getByLabelText('Toggle comments'))
      const textarea = await screen.findByLabelText('New comment')
      await user.type(textarea, 'blocked on review{Enter}')

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/plan-items/7/comments'),
          expect.objectContaining({ method: 'POST' }),
        )
      })
      const postCall = mockFetch.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      )
      expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
        content: 'blocked on review',
      })
      expect(await screen.findByText('blocked on review')).toBeInTheDocument()
      expect(screen.getByText('用户')).toBeInTheDocument()
      expect((textarea as HTMLTextAreaElement).value).toBe('')
    })

    it('inserts a newline on Shift+Enter without submitting', async () => {
      const user = userEvent.setup()
      mockCommentApi([])

      renderRow({ commentCount: 0 })
      await user.click(screen.getByLabelText('Toggle comments'))
      const textarea = await screen.findByLabelText('New comment')
      await user.type(textarea, 'line one{Shift>}{Enter}{/Shift}line two')

      expect((textarea as HTMLTextAreaElement).value).toContain('\n')
      expect(
        mockFetch.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(false)
    })

    it('does not submit while an IME composition is active', async () => {
      const user = userEvent.setup()
      mockCommentApi([])

      renderRow({ commentCount: 0 })
      await user.click(screen.getByLabelText('Toggle comments'))
      const textarea = await screen.findByLabelText('New comment')
      await user.type(textarea, 'composing')

      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })

      expect(
        mockFetch.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(false)
    })

    it('asks for confirmation before deleting a comment', async () => {
      const user = userEvent.setup()
      mockCommentApi([
        {
          id: 201,
          planItemId: 7,
          content: 'Old note',
          author: null,
          createdAt: '2026-10-14T09:00:00.000Z',
        },
      ])
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

      renderRow({ commentCount: 1 })
      await user.click(screen.getByLabelText('Toggle comments'))
      await screen.findByText('Old note')

      await user.click(screen.getByLabelText('Delete comment 201'))
      expect(confirmSpy).toHaveBeenCalled()
      expect(
        mockFetch.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(false)

      confirmSpy.mockReturnValue(true)
      await user.click(screen.getByLabelText('Delete comment 201'))

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/plan-items/7/comments/201'),
          expect.objectContaining({ method: 'DELETE' }),
        )
      })
      expect(screen.queryByText('Old note')).not.toBeInTheDocument()
    })

    it('renders @id citations in comments as links and keeps %id/#tag as plain text', async () => {
      const user = userEvent.setup()
      mockCommentApi([
        {
          id: 201,
          planItemId: 7,
          content: 'see @17 about %42 #review',
          author: null,
          createdAt: '2026-10-14T09:00:00.000Z',
        },
      ])

      renderRow({ commentCount: 1 })
      await user.click(screen.getByLabelText('Toggle comments'))

      expect(await screen.findByRole('button', { name: '@17' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '%42' })).not.toBeInTheDocument()
      expect(screen.getByText(/%42 #review/)).toBeInTheDocument()
    })

    it('opens a read-only event preview when a comment citation is clicked', async () => {
      const user = userEvent.setup()
      mockCommentApi(
        [
          {
            id: 201,
            planItemId: 7,
            content: 'see @17',
            author: null,
            createdAt: '2026-10-14T09:00:00.000Z',
          },
        ],
        {
          17: {
            status: 200,
            body: {
              id: 17,
              content: 'The motivating event',
              eventTime: '2026-10-13T09:00:00.000Z',
              source: 'manual',
              isImportant: false,
              tags: [],
            },
          },
        },
      )

      renderRow({ commentCount: 1 })
      await user.click(screen.getByLabelText('Toggle comments'))
      await user.click(await screen.findByRole('button', { name: '@17' }))

      expect(await screen.findByText('Event #17')).toBeInTheDocument()
      expect(screen.getByText('The motivating event')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /locate this event/i })).not.toBeInTheDocument()
    })

    it('reports a missing event when a dangling citation is clicked', async () => {
      const user = userEvent.setup()
      mockCommentApi(
        [
          {
            id: 201,
            planItemId: 7,
            content: 'see @999',
            author: null,
            createdAt: '2026-10-14T09:00:00.000Z',
          },
        ],
        { 999: { status: 404 } },
      )

      renderRow({ commentCount: 1 })
      await user.click(screen.getByLabelText('Toggle comments'))
      await user.click(await screen.findByRole('button', { name: '@999' }))

      expect(await screen.findByText('Event Not Found')).toBeInTheDocument()
      expect(screen.getByText(/does not exist or has been deleted/i)).toBeInTheDocument()
    })
  })

  describe('monthly review tree', () => {
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

    function renderMonthItem(
      overrides: Record<string, unknown> = {},
      props: Partial<{
        onUpdate: typeof mockOnUpdate
        onDelete: typeof mockOnDelete
        onDefer: typeof mockOnDefer
        attachCandidates: AttachCandidateWeek[]
        onAttach: (childId: number, parentItemId: number) => void
        childParentOptions: PlanRowItem[]
        selectedItemId: number | null
        onSelect: (id: number) => void
      }> = {},
    ) {
      return render(
        <PeriodPlanItemRow
          item={{
            ...mockItem,
            id: 10,
            text: 'Month goal',
            periodPlanId: 2,
            ...overrides,
          }}
          onUpdate={props.onUpdate ?? mockOnUpdate}
          onDelete={props.onDelete ?? mockOnDelete}
          onDefer={props.onDefer ?? mockOnDefer}
          attachCandidates={props.attachCandidates}
          onAttach={props.onAttach}
          childParentOptions={props.childParentOptions}
          selectedItemId={props.selectedItemId}
          onSelect={props.onSelect}
        />
      )
    }

    it('shows the composed fulfillment badge with its direct and indirect breakdown', () => {
      renderMonthItem({
        fulfillmentCount: 5,
        directFulfillmentCount: 2,
        indirectFulfillmentCount: 3,
        childItems: [],
      })

      expect(screen.getByText('5 fulfilled')).toBeInTheDocument()
      expect(screen.getByText('2 direct · 3 indirect')).toBeInTheDocument()
    })

    it('reveals attached week items labeled with their week when expanded', async () => {
      const user = userEvent.setup()
      renderMonthItem({
        fulfillmentCount: 2,
        directFulfillmentCount: 1,
        indirectFulfillmentCount: 1,
        childItems: [
          makeChild({ id: 21, text: 'High child', priority: 'high', weekPeriodStart: '2026-10-12', weekPeriodEnd: '2026-10-18' }),
          makeChild({ id: 22, text: 'Normal child', priority: 'normal', weekPeriodStart: '2026-10-26', weekPeriodEnd: '2026-11-01' }),
        ],
      })

      expect(screen.queryByText('High child')).not.toBeInTheDocument()

      await user.click(screen.getByLabelText('Toggle attached week items'))

      expect(screen.getByText('High child')).toBeInTheDocument()
      expect(screen.getByText('Normal child')).toBeInTheDocument()
      // The API already orders children; the row must not reorder them.
      const childTexts = screen
        .getAllByText(/^(High|Normal) child$/)
        .map((element) => element.textContent)
      expect(childTexts).toEqual(['High child', 'Normal child'])
      expect(screen.getByText('Week 2026-10-12 - 2026-10-18')).toBeInTheDocument()
      expect(screen.getByText('Week 2026-10-26 - 2026-11-01')).toBeInTheDocument()
    })

    it('lazily loads a child week item’s fulfilling events with full text', async () => {
      const user = userEvent.setup()
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [
            {
              id: 31,
              content: 'A very long fulfilling event that used to be clamped to two lines',
              eventTime: '2026-10-14T09:00:00.000Z',
              isManual: true,
            },
          ],
        }),
      })
      renderMonthItem({
        fulfillmentCount: 1,
        directFulfillmentCount: 0,
        indirectFulfillmentCount: 1,
        childItems: [makeChild({ id: 21, text: 'Week child' })],
      })

      await user.click(screen.getByLabelText('Toggle attached week items'))
      expect(mockFetch).not.toHaveBeenCalled()

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByLabelText('Toggle fulfillment events'))

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/plan-items/21/fulfillment'),
          expect.anything(),
        )
      })
      const event = await screen.findByText(
        'A very long fulfilling event that used to be clamped to two lines',
      )
      // Full text in the monthly review, not a truncated preview.
      expect(event).not.toHaveClass('line-clamp-2')
    })

    it('links a child week item to its week view', async () => {
      const user = userEvent.setup()
      renderMonthItem({ childItems: [makeChild({ id: 21 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))

      const link = screen.getByRole('link', { name: 'Week 2026-10-12 - 2026-10-18' })
      expect(link).toHaveAttribute('href', '/plans?scope=week&start=2026-10-12')
    })

    it('renders inherited week items from ancestor months as a read-only, expandable group', async () => {
      const user = userEvent.setup()
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [
            {
              id: 51,
              content: 'Inherited evidence',
              eventTime: '2026-09-09T09:00:00.000Z',
              isManual: true,
            },
          ],
        }),
      })
      renderMonthItem({
        fulfillmentCount: 1,
        directFulfillmentCount: 0,
        indirectFulfillmentCount: 1,
        childItems: [],
        inheritedChildGroups: [
          {
            ancestorItemId: 99,
            ancestorMonth: '2026-09',
            items: [
              {
                id: 41,
                text: 'Inherited child',
                status: 'planned',
                projectScope: 'work',
                priority: 'normal',
                isImportant: false,
                isUrgent: false,
                weekPeriodStart: '2026-09-07',
                weekPeriodEnd: '2026-09-13',
                fulfillmentCount: 1,
              },
            ],
          },
        ],
      })

      expect(screen.queryByText('Inherited child')).not.toBeInTheDocument()
      await user.click(screen.getByLabelText('Toggle inherited week items'))

      expect(screen.getByText('From 2026-09')).toBeInTheDocument()
      const row = within(
        screen.getByRole('group', { name: 'Inherited week item Inherited child' }),
      )
      expect(row.getByText('Inherited child')).toBeInTheDocument()
      expect(row.getByText('Week 2026-09-07 - 2026-09-13')).toBeInTheDocument()
      // Review-only: no write or comment controls.
      expect(row.queryByLabelText(/^Status for %/)).not.toBeInTheDocument()
      expect(row.queryByLabelText(/^Priority for %/)).not.toBeInTheDocument()
      expect(row.queryByLabelText('Defer to next period')).not.toBeInTheDocument()
      expect(row.queryByLabelText('Delete item')).not.toBeInTheDocument()
      expect(row.queryByLabelText('Toggle comments')).not.toBeInTheDocument()

      // Its fulfilling events expand in place, so the indirect badge is
      // inspectable without navigating to the ancestor month.
      await user.click(row.getByLabelText('Toggle fulfillment events'))
      expect(await screen.findByText('Inherited evidence')).toBeInTheDocument()
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/plan-items/41/fulfillment'),
        expect.anything(),
      )
    })

    it('selects inherited week items through the numbered row control', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      renderMonthItem(
        {
          inheritedChildGroups: [
            {
              ancestorItemId: 99,
              ancestorMonth: '2026-09',
              items: [
                {
                  id: 41,
                  text: 'Inherited child',
                  status: 'planned',
                  projectScope: 'work',
                  priority: 'normal',
                  isImportant: false,
                  isUrgent: false,
                  weekPeriodStart: '2026-09-07',
                  weekPeriodEnd: '2026-09-13',
                  fulfillmentCount: 1,
                },
              ],
            },
          ],
        },
        { selectedItemId: 41, onSelect },
      )

      await user.click(screen.getByLabelText('Toggle inherited week items'))

      const row = within(
        screen.getByRole('group', { name: 'Inherited week item Inherited child' }),
      )
      const indexButton = row.getByRole('button', { name: 'Inspect plan item %41' })
      expect(indexButton).toHaveAttribute('aria-pressed', 'true')

      await user.click(indexButton)
      expect(onSelect).toHaveBeenCalledWith(41)
    })

    it('offers the comment toggle on child week item rows while keeping text read-only', async () => {
      const user = userEvent.setup()
      renderMonthItem({ childItems: [makeChild({ id: 21 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      expect(childRow.getByLabelText('Toggle comments')).toBeInTheDocument()
      // The text stays read-only inside the monthly review tree.
      expect(childRow.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('shows a child week item’s comment badge from the composed count without loading', async () => {
      const user = userEvent.setup()
      renderMonthItem({ childItems: [makeChild({ id: 21, commentCount: 2 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      expect(childRow.getByText('2 comments')).toBeInTheDocument()
      // Composed counts are eager in the payload; comments stay lazy.
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('expands a child week item’s comments with ancestor aggregation and source-period label', async () => {
      const user = userEvent.setup()
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
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
        }),
      })
      renderMonthItem({ childItems: [makeChild({ id: 21, commentCount: 2 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))
      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByLabelText('Toggle comments'))

      expect(mockFetch).toHaveBeenCalledWith('/api/plan-items/21/comments', expect.anything())
      expect(await childRow.findByText('Ancestor week blocker')).toBeInTheDocument()
      expect(childRow.getByText('Own week note')).toBeInTheDocument()
      // The ancestor comment keeps its source-period label and cannot be
      // deleted from the successor week item.
      expect(childRow.getByText('Week 2026-10-05 - 2026-10-11')).toBeInTheDocument()
      expect(childRow.queryByLabelText('Delete comment 401')).not.toBeInTheDocument()
      expect(childRow.getByLabelText('Delete comment 402')).toBeInTheDocument()
      // The badge equals what expansion shows.
      const list = childRow.getByRole('list')
      expect(within(list).getAllByRole('listitem')).toHaveLength(2)
      expect(childRow.getByText('2 comments')).toBeInTheDocument()
    })

    it('offers status, priority and flag operations on attached week items', async () => {
      const user = userEvent.setup()
      renderMonthItem({ childItems: [makeChild({ id: 21 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))

      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.selectOptions(childRow.getByLabelText('Status for %21'), 'done')
      await user.selectOptions(childRow.getByLabelText('Priority for %21'), 'high')
      await user.click(childRow.getByRole('button', { name: 'Toggle plan item important flag' }))
      await user.click(childRow.getByRole('button', { name: 'Toggle plan item urgent flag' }))

      expect(mockOnUpdate).toHaveBeenCalledWith(21, { status: 'done' })
      expect(mockOnUpdate).toHaveBeenCalledWith(21, { priority: 'high' })
      expect(mockOnUpdate).toHaveBeenCalledWith(21, { isImportant: true })
      expect(mockOnUpdate).toHaveBeenCalledWith(21, { isUrgent: true })
    })

    it('defers an attached week item after confirmation', async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      renderMonthItem({ childItems: [makeChild({ id: 21 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))
      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByLabelText('Defer to next period'))

      expect(mockOnDefer).toHaveBeenCalledWith(21)
    })

    it('warns about referring events before deleting an attached week item', async () => {
      const user = userEvent.setup()
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          referrers: [
            { id: 11, content: 'Worked on %21', eventTime: '2026-10-14T09:00:00.000Z' },
          ],
        }),
      })
      renderMonthItem({ childItems: [makeChild({ id: 21 })] })

      await user.click(screen.getByLabelText('Toggle attached week items'))
      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      await user.click(childRow.getByLabelText('Delete item'))

      expect(await screen.findByText('Worked on %21')).toBeInTheDocument()
      expect(screen.getByText(/referenced by 1 event/i)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /^delete$/i }))

      expect(mockOnDelete).toHaveBeenCalledWith(21)
    })

    it('offers only the provided attach candidates, grouped by week, and reports the pick', async () => {
      const user = userEvent.setup()
      const onAttach = vi.fn()
      renderMonthItem(
        { childItems: [] },
        {
          attachCandidates: [
            {
              periodStart: '2026-10-12',
              periodEnd: '2026-10-18',
              items: [
                {
                  id: 31,
                  text: 'High unparented',
                  status: 'planned',
                  projectScope: 'work',
                  priority: 'high',
                  isImportant: false,
                  isUrgent: false,
                },
              ],
            },
            {
              periodStart: '2026-10-26',
              periodEnd: '2026-11-01',
              items: [
                {
                  id: 33,
                  text: 'Late unparented',
                  status: 'in_progress',
                  projectScope: 'personal',
                  priority: 'low',
                  isImportant: false,
                  isUrgent: false,
                },
              ],
            },
          ],
          onAttach,
        },
      )

      // The top-level monthly row has no parent selector of its own.
      expect(screen.queryByLabelText(/^Parent month item for %/)).not.toBeInTheDocument()

      await user.click(screen.getByLabelText('Attach week item'))
      const dialog = within(await screen.findByRole('dialog'))

      const week3 = within(dialog.getByRole('group', { name: 'Week 2026-10-12 - 2026-10-18' }))
      const week5 = within(dialog.getByRole('group', { name: 'Week 2026-10-26 - 2026-11-01' }))
      expect(week3.getByRole('button', { name: 'High unparented' })).toBeInTheDocument()
      expect(week5.getByRole('button', { name: 'Late unparented' })).toBeInTheDocument()

      await user.click(week3.getByRole('button', { name: 'High unparented' }))

      expect(onAttach).toHaveBeenCalledWith(31, 10)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('shows an empty message when the month has no unparented candidates', async () => {
      const user = userEvent.setup()
      renderMonthItem({ childItems: [] }, { attachCandidates: [], onAttach: vi.fn() })

      await user.click(screen.getByLabelText('Attach week item'))

      expect(
        await screen.findByText('No unparented week items in this month.'),
      ).toBeInTheDocument()
    })

    it('detaches and re-parents an attached week item in place', async () => {
      const user = userEvent.setup()
      const onUpdate = vi.fn()
      renderMonthItem(
        { childItems: [makeChild({ id: 21, text: 'Week child' })] },
        {
          onUpdate,
          childParentOptions: [
            { ...mockItem, id: 10, text: 'Month goal' },
            { ...mockItem, id: 11, text: 'Other goal' },
          ],
        },
      )

      await user.click(screen.getByLabelText('Toggle attached week items'))
      const childRow = within(screen.getByRole('group', { name: 'Week item Week child' }))
      const parentSelect = childRow.getByLabelText('Parent month item for %21') as HTMLSelectElement

      // The current parent is selected, detach is the empty option, and only
      // the month's own items are offered as re-parent targets.
      expect(parentSelect.value).toBe('10')
      expect(within(parentSelect).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'No month parent',
        'Month goal',
        'Other goal',
      ])

      await user.selectOptions(parentSelect, '11')
      expect(onUpdate).toHaveBeenCalledWith(21, { parentItemId: 11 })

      await user.selectOptions(parentSelect, '')
      expect(onUpdate).toHaveBeenCalledWith(21, { parentItemId: null })
    })
  })
})
