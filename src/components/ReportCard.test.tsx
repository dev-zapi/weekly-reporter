import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReportCard } from './ReportCard'
import type { Report } from '@/lib/db/schema'

describe('ReportCard', () => {
  const baseReport: Report = {
    id: 1,
    title: '测试周报',
    content: '周报内容',
    weekStart: '2024-01-08',
    weekEnd: '2024-01-14',
    aiStyleOverride: null,
    createdAt: new Date('2024-01-15T10:00:00'),
    updatedAt: new Date('2024-01-15T10:00:00'),
  }

  it('should render the numbered reference, title, week range, and created date', () => {
    render(
      <ReportCard report={baseReport} audience="leadership" selected={false} onSelect={vi.fn()} onDelete={vi.fn()} />,
    )

    expect(screen.getByText('R1')).toBeInTheDocument()
    expect(screen.getByText('测试周报')).toBeInTheDocument()
    expect(screen.getByText(/Jan 8, 2024/)).toBeInTheDocument()
    expect(screen.getByText(/Jan 14, 2024/)).toBeInTheDocument()
    expect(screen.getByText(/Created/)).toBeInTheDocument()
    expect(screen.getByText(/Jan 15, 2024/)).toBeInTheDocument()
  })

  it('should format different week ranges correctly', () => {
    const report: Report = {
      ...baseReport,
      id: 2,
      weekStart: '2024-12-30',
      weekEnd: '2025-01-05',
    }
    render(<ReportCard report={report} audience="leadership" selected={false} onSelect={vi.fn()} onDelete={vi.fn()} />)

    expect(screen.getByText(/Dec 30, 2024/)).toBeInTheDocument()
    expect(screen.getByText(/Jan 5, 2025/)).toBeInTheDocument()
  })

  it('should call onSelect with the report id and expose its selected state', () => {
    const onSelect = vi.fn()
    render(<ReportCard report={baseReport} audience="leadership" selected onSelect={onSelect} onDelete={vi.fn()} />)

    const selectButton = screen.getByRole('button', { pressed: true })
    fireEvent.click(selectButton)

    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('should call onDelete when delete button is clicked and confirmed', () => {
    const onDelete = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ReportCard report={baseReport} audience="leadership" selected={false} onSelect={vi.fn()} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete 测试周报' }))

    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('should link to the report detail page and the edit page', () => {
    render(<ReportCard report={baseReport} audience="leadership" selected={false} onSelect={vi.fn()} onDelete={vi.fn()} />)

    const links = screen.getAllByRole('link')
    expect(links.find((link) => link.getAttribute('href') === '/reports/1?audience=leadership')).toBeDefined()
    expect(links.find((link) => link.getAttribute('href') === '/edit/1')).toBeDefined()
    expect(
      screen.getByRole('link', { name: 'Open full review for 测试周报' }),
    ).toHaveAttribute('href', '/reports/1?audience=leadership')
  })

  it('carries the previewed audience into full review instead of omitting it', () => {
    render(
      <ReportCard report={baseReport} audience="personal" selected={false} onSelect={vi.fn()} onDelete={vi.fn()} />,
    )

    expect(
      screen.getByRole('link', { name: 'Open full review for 测试周报' }),
    ).toHaveAttribute('href', '/reports/1?audience=personal')
  })
})
