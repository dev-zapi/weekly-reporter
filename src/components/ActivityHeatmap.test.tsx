import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActivityHeatmap, type HeatmapData } from './ActivityHeatmap'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

describe('ActivityHeatmap', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(374)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const makeData = (entries: Array<[string, number]>): HeatmapData[] =>
    entries.map(([date, count]) => ({ date, count }))

  it('uses the measured container width after the initial client render', async () => {
    const { container } = render(
      <ActivityHeatmap data={[]} selectedDate={null} onDateSelect={vi.fn()} />
    )

    await waitFor(() => {
      const grid = container.querySelector('div[style*="grid-template-columns"]')
      expect(grid?.getAttribute('style')).toContain('repeat(29, 10px)')
    })
  })

  it('should render cells for each day in data', () => {
    const data = makeData([
      ['2026-07-14', 5],
      ['2026-07-13', 3],
    ])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate={null} onDateSelect={vi.fn()} />
    )

    // Should render at least 2 cells with data
    const cells = container.querySelectorAll('[data-count]')
    expect(cells.length).toBeGreaterThanOrEqual(2)
  })

  it('should show tooltip with count and date on hover', () => {
    const data = makeData([['2026-07-14', 5]])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate={null} onDateSelect={vi.fn()} />
    )

    const cell = container.querySelector('[data-count="5"]')
    expect(cell).toBeTruthy()
    // Check for title attribute (native tooltip)
    expect(cell?.getAttribute('title')).toContain('5')
    expect(cell?.getAttribute('title')).toContain('2026-07-14')
  })

  it('should call onDateSelect when a cell is clicked', () => {
    const onDateSelect = vi.fn()
    const data = makeData([['2026-07-14', 5]])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate={null} onDateSelect={onDateSelect} />
    )

    const cell = container.querySelector('[data-count="5"]')
    fireEvent.click(cell!)

    expect(onDateSelect).toHaveBeenCalledWith('2026-07-14')
  })

  it('should call onDateSelect(null) when clicking the already-selected date', () => {
    const onDateSelect = vi.fn()
    const data = makeData([['2026-07-14', 5]])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate="2026-07-14" onDateSelect={onDateSelect} />
    )

    const cell = container.querySelector('[data-count="5"]')
    fireEvent.click(cell!)

    expect(onDateSelect).toHaveBeenCalledWith(null)
  })

  it('should render empty heatmap when data is empty', () => {
    const { container } = render(
      <ActivityHeatmap data={[]} selectedDate={null} onDateSelect={vi.fn()} />
    )

    // Should still render the container (with empty grid)
    expect(container.firstChild).toBeTruthy()
  })

  it('should show month labels', () => {
    const data = makeData([
      ['2026-01-05', 1],
      ['2026-02-05', 1],
      ['2026-03-05', 1],
    ])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate={null} onDateSelect={vi.fn()} />
    )

    // At least one locale-formatted month label should be present.
    const labels = container.querySelectorAll('div.relative > span.absolute')
    expect(labels.length).toBeGreaterThan(0)
  })

  it('should highlight selected date', () => {
    const data = makeData([['2026-07-14', 5]])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate="2026-07-14" onDateSelect={vi.fn()} />
    )

    const cell = container.querySelector('[data-count="5"]')
    expect(cell?.getAttribute('data-selected')).toBe('true')
    expect(cell).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders day cells as buttons with an accessible date label', () => {
    const data = makeData([['2026-07-14', 5]])

    render(<ActivityHeatmap data={data} selectedDate={null} onDateSelect={vi.fn()} />)

    const cell = screen.getByRole('button', { name: '5 events on 2026-07-14' })
    expect(cell.tagName).toBe('BUTTON')
    expect(cell).toHaveAttribute('type', 'button')
    expect(cell).toHaveAttribute('aria-pressed', 'false')
  })

  it('selects and clears a date from the keyboard', async () => {
    const user = userEvent.setup()
    const onDateSelect = vi.fn()
    const data = makeData([['2026-07-14', 5]])

    const { rerender } = render(
      <ActivityHeatmap data={data} selectedDate={null} onDateSelect={onDateSelect} />
    )

    const cell = screen.getByRole('button', { name: '5 events on 2026-07-14' })
    cell.focus()
    expect(cell).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onDateSelect).toHaveBeenLastCalledWith('2026-07-14')

    rerender(
      <ActivityHeatmap data={data} selectedDate="2026-07-14" onDateSelect={onDateSelect} />
    )
    const selectedCell = screen.getByRole('button', { name: '5 events on 2026-07-14' })
    selectedCell.focus()
    await user.keyboard(' ')
    expect(onDateSelect).toHaveBeenLastCalledWith(null)
  })

  it('keeps a visible keyboard focus treatment on day cells', () => {
    const data = makeData([['2026-07-14', 5]])

    render(<ActivityHeatmap data={data} selectedDate={null} onDateSelect={vi.fn()} />)

    const cell = screen.getByRole('button', { name: '5 events on 2026-07-14' })
    cell.focus()
    // jsdom cannot resolve :focus-visible, so this asserts the shared focus
    // class is attached; the module rule supplies the 3px outline.
    expect(cell.className).toContain('heatmapDay')
  })

  it('should assign correct color level based on count', () => {
    const data = makeData([
      ['2026-07-08', 0],   // level 0
      ['2026-07-09', 1],   // level 1
      ['2026-07-10', 4],   // level 2
      ['2026-07-11', 7],   // level 3
      ['2026-07-12', 12],  // level 4
      ['2026-07-13', 18],  // level 5
      ['2026-07-14', 25],  // level 6
    ])

    const { container } = render(
      <ActivityHeatmap data={data} selectedDate={null} onDateSelect={vi.fn()} />
    )

    const levels = Array.from(container.querySelectorAll('[data-level]'))
      .map(el => el.getAttribute('data-level'))

    expect(levels).toContain('0')
    expect(levels).toContain('1')
    expect(levels).toContain('2')
    expect(levels).toContain('3')
    expect(levels).toContain('4')
    expect(levels).toContain('5')
    expect(levels).toContain('6')
  })
})
