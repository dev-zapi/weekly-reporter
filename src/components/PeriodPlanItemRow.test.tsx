import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PeriodPlanItemRow } from './PeriodPlanItemRow'

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
})
