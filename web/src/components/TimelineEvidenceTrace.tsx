import { Link } from 'react-router'
import { ArrowRight, Link2 } from 'lucide-react'
import type { TimelineEvent } from '@/lib/event-view'
import styles from './timeline.module.css'

interface TimelineEvidenceTraceProps {
  events: TimelineEvent[]
  selectedEventId: number | null
}

/**
 * Persistent inspector for the selected evidence record. The chain mirrors the
 * reporting path: live event → frozen audience snapshot → human review.
 * Only the stable ID is claimed here; no report status is inferred.
 */
export function TimelineEvidenceTrace({ events, selectedEventId }: TimelineEvidenceTraceProps) {
  const event = selectedEventId === null
    ? null
    : events.find((item) => item.id === selectedEventId) ?? null

  if (!event) {
    return (
      <aside className={styles.tracePanel} aria-label="Evidence trace">
        <div className={styles.sectionHeading}>
          <div>
            <h2>Evidence trace</h2>
            <p>Select a work item to inspect its stable ID and reporting path.</p>
          </div>
          <Link2 size={17} aria-hidden="true" />
        </div>
        <p className={styles.traceCopy}>
          Report inclusion is fixed only when an audience snapshot is created.
          Live edits never rewrite an existing report basis.
        </p>
      </aside>
    )
  }

  return (
    <aside className={styles.tracePanel} aria-label="Evidence trace">
      <div className={styles.sectionHeading}>
        <div>
          <h2>Evidence trace</h2>
          <p>Live evidence and frozen report basis.</p>
        </div>
        <Link2 size={17} aria-hidden="true" />
      </div>

      <p className={styles.traceEvent}>Selected: {event.content}</p>

      <div className={styles.traceChain} aria-label={`Evidence trace for event ${event.id}`}>
        <span className={styles.traceNode}>
          @{event.id}
          <small>Live event</small>
        </span>
        <span className={styles.traceLine} aria-hidden="true" />
        <span className={styles.traceNode}>
          Next snapshot
          <small>Not yet frozen</small>
        </span>
        <span className={styles.traceLine} aria-hidden="true" />
        <span className={styles.traceNode}>
          Review
          <small>Human decision</small>
        </span>
      </div>

      <p className={styles.traceCopy}>
        Report inclusion is fixed only when an audience snapshot is created.
        Live edits never rewrite an existing report basis.
      </p>

      <Link to="/reports" className={styles.textButton}>
        Review reports <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </aside>
  )
}
