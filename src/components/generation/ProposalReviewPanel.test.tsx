import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ProposalReviewPanel } from './ProposalReviewPanel'

const proposal = {
  id: 42,
  content: '# 本周完成\n\n- 已完成：验收事项',
  summary: ['保留原稿事实', '提交完整候选终版'],
  sourceRevision: 3,
  status: 'pending',
  createdAt: '2026-08-19T00:00:00.000Z',
  baselineContent: '# 本周完成\n\n- 验收事项',
}

describe('ProposalReviewPanel', () => {
  it('shows the real review state, source, and diff views before adoption', () => {
    const onAccept = vi.fn()
    const { container } = render(
      <ProposalReviewPanel proposal={proposal} editable accepting={false} onAccept={onAccept} />,
    )

    const review = screen.getByRole('complementary', { name: 'Read-only proposal review' })
    expect(screen.getByRole('heading', { name: 'Proposed final version' })).toBeInTheDocument()
    expect(screen.getByText('Pending review')).toBeInTheDocument()
    expect(screen.getByText('Source revision r3')).toBeInTheDocument()
    expect(screen.getByText('Baseline comparison available')).toBeInTheDocument()
    expect(screen.getByText('Awaiting the user decision')).toBeInTheDocument()
    expect(container.querySelectorAll('textarea, input, [contenteditable="true"]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: 'Markdown source' }))
    expect(screen.getByTestId('proposal-markdown-source')).toHaveTextContent('# 本周完成')

    fireEvent.click(screen.getByRole('tab', { name: 'Difference' }))
    expect(container.querySelectorAll('[data-diff-type="remove"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-diff-type="add"]')).toHaveLength(1)

    fireEvent.click(screen.getByRole('tab', { name: 'Rendered preview' }))
    expect(screen.getByRole('heading', { name: '本周完成' })).toBeInTheDocument()

    fireEvent.click(within(review).getByRole('button', { name: 'Accept and save final version' }))
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('does not offer adoption for an accepted or missing proposal', () => {
    const { rerender } = render(
      <ProposalReviewPanel proposal={{ ...proposal, status: 'accepted' }} editable accepting={false} onAccept={vi.fn()} />,
    )
    expect(screen.getByText('Accepted')).toBeInTheDocument()
    const checklist = screen.getByRole('list', { name: 'Proposal review state' })
    const adoptionState = within(checklist).getByText('Adopted by the user').closest('li')
    expect(adoptionState?.querySelector('.lucide-check')).not.toBeNull()
    expect(adoptionState?.querySelector('.lucide-circle')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept and save final version' })).not.toBeInTheDocument()

    rerender(<ProposalReviewPanel proposal={null} editable accepting={false} onAccept={vi.fn()} />)
    expect(screen.getByText(/propose_final_report/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept and save final version' })).not.toBeInTheDocument()
  })
})
