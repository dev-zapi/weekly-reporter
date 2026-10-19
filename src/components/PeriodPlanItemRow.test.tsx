import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeriodPlanItemRow } from './PeriodPlanItemRow'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

describe('PeriodPlanItemRow', () => {
  const mockItem = {
    id: 1,
    periodPlanId: 1,
    text: 'Test item',
    status: 'planned' as const,
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
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('planned')
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

    const statusSelect = screen.getByLabelText('Status')
    await user.selectOptions(statusSelect, 'done')

    expect(mockOnUpdate).toHaveBeenCalledWith(1, { status: 'done' })
  })

  it('calls onUpdate when project scope is changed', async () => {
    const user = userEvent.setup()

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const scopeSelect = screen.getByLabelText('Project scope')
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
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <PeriodPlanItemRow
        item={mockItem}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
        onDefer={mockOnDefer}
      />
    )

    const deleteButton = screen.getByLabelText('Delete item')
    await user.click(deleteButton)

    expect(mockOnDelete).toHaveBeenCalledWith(1)
  })

  it('does not call onDelete when confirmation is cancelled', async () => {
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

    const deleteButton = screen.getByLabelText('Delete item')
    await user.click(deleteButton)

    expect(mockOnDelete).not.toHaveBeenCalled()
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
      expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe(status)
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

    const parentSelect = screen.getByLabelText('Parent month item')
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

    expect(screen.queryByLabelText('Parent month item')).not.toBeInTheDocument()
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

    const parentSelect = screen.getByLabelText('Parent month item')
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
})
