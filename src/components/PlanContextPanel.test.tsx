import { render, screen, within } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PlanContextPanel } from './PlanContextPanel'
import type { PlanRowItem } from './PeriodPlanItemRow'

function makeItem(overrides: Partial<PlanRowItem> = {}): PlanRowItem {
  return {
    id: 42,
    text: 'Ship the migration',
    status: 'in_progress',
    priority: 'high',
    isImportant: true,
    isUrgent: false,
    projectScope: 'work',
    parentItemId: null,
    fulfillmentCount: 3,
    commentCount: 2,
    directFulfillmentCount: 1,
    indirectFulfillmentCount: 2,
    ...overrides,
  }
}

describe('PlanContextPanel', () => {
  it('prompts for an item when nothing is selected', () => {
    render(<PlanContextPanel item={null} periodLabel="2026-10-12 - 2026-10-18" scope="week" />)

    expect(screen.getByText('No plan item selected')).toBeInTheDocument()
    expect(
      screen.getByText(/select a numbered item/i),
    ).toBeInTheDocument()
  })

  it('keeps the selected item’s stable reference and planning context visible', () => {
    render(
      <PlanContextPanel
        item={makeItem()}
        periodLabel="2026-10-12 - 2026-10-18"
        scope="week"
      />,
    )

    expect(screen.getByText(/^Plan item %42$/)).toBeInTheDocument()
    expect(screen.getByText('Selected item: Ship the migration')).toBeInTheDocument()

    const panel = screen.getByLabelText('Selected plan item')
    expect(within(panel).getAllByText('In Progress').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('Work').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('高').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('Yes').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('No').length).toBeGreaterThan(0)
    expect(within(panel).getByText('3 linked events')).toBeInTheDocument()
    expect(within(panel).getByText('2 comment records')).toBeInTheDocument()
  })

  it('shows the attached week, parent month, and deferral chain', () => {
    render(
      <PlanContextPanel
        item={makeItem({
          id: 77,
          text: 'Week follow-up',
          weekPeriodStart: '2026-10-12',
          weekPeriodEnd: '2026-10-18',
          parentItemId: 10,
          deferredFromItemId: 5,
        })}
        periodLabel="2026-10"
        scope="month"
        parentText="Month goal"
      />,
    )

    const panel = screen.getByLabelText('Selected plan item')
    expect(within(panel).getByText('Week of 2026-10-12 to 2026-10-18')).toBeInTheDocument()
    expect(within(panel).getByText('Month goal')).toBeInTheDocument()
    expect(within(panel).getByText('From %5')).toBeInTheDocument()
  })
})
