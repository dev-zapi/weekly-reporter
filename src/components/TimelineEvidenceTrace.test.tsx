import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimelineEvidenceTrace } from './TimelineEvidenceTrace'
import type { TimelineEvent } from '@/lib/event-view'

function makeEvent(id: number, content: string): TimelineEvent {
  return {
    id,
    content,
    source: 'manual',
    eventTime: new Date('2026-11-03T10:00:00'),
    isImportant: false,
    metadata: null,
    createdAt: new Date('2026-11-03T10:00:00'),
    updatedAt: new Date('2026-11-03T10:00:00'),
  } as unknown as TimelineEvent
}

describe('TimelineEvidenceTrace', () => {
  it('prompts the user to select a record when nothing is selected', () => {
    render(<TimelineEvidenceTrace events={[]} selectedEventId={null} />)
    expect(screen.getByText(/select a work item/i)).toBeInTheDocument()
    expect(screen.queryByText(/@/)).not.toBeInTheDocument()
  })

  it('shows the selected stable id and the unfrozen reporting path', () => {
    render(
      <TimelineEvidenceTrace
        events={[makeEvent(7, 'Refactored the ingestion worker')]}
        selectedEventId={7}
      />,
    )

    expect(screen.getByText('@7')).toBeInTheDocument()
    expect(screen.getByText('Live event')).toBeInTheDocument()
    expect(screen.getByText('Next snapshot')).toBeInTheDocument()
    expect(screen.getByText('Not yet frozen')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.getByText('Human decision')).toBeInTheDocument()
    expect(screen.getByText(/Live edits never rewrite an existing report basis/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /review reports/i })).toHaveAttribute('href', '/reports')
  })

  it('falls back to the selection prompt when the selected id is not loaded', () => {
    render(
      <TimelineEvidenceTrace
        events={[makeEvent(7, 'Refactored the ingestion worker')]}
        selectedEventId={99}
      />,
    )
    expect(screen.getByText(/select a work item/i)).toBeInTheDocument()
    expect(screen.queryByText('@99')).not.toBeInTheDocument()
  })
})
