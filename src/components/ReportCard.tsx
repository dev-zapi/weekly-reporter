'use client'

import Link from 'next/link'
import { ArrowRight, Pencil, Trash2 } from 'lucide-react'
import type { AudienceVariant, Report } from '@/lib/db/schema'
import { formatSystemDate } from '@/lib/time-format'
import styles from './ReportsLibrary.module.css'

/** The subset of a report rendered by the library index. */
export type ReportSummary = Pick<Report, 'id' | 'title' | 'weekStart' | 'weekEnd' | 'createdAt'>

interface ReportCardProps {
  report: ReportSummary
  /** Audience currently previewed in the library; carried into full review. */
  audience: AudienceVariant
  selected: boolean
  deleting?: boolean
  onSelect: (id: number) => void
  onDelete: (id: number) => void
}

/**
 * One numbered row in the report index. Selection stays in the primary area;
 * the trailing controls keep edit, delete, and full review reachable without
 * turning the record into a card.
 */
export function ReportCard({ report, audience, selected, deleting = false, onSelect, onDelete }: ReportCardProps) {
  const weekStart = formatSystemDate(report.weekStart)
  const weekEnd = formatSystemDate(report.weekEnd)
  const createdAt = formatSystemDate(report.createdAt)

  return (
    <div
      className={`${styles.reportRow} ${selected ? styles.selectedRow : ''}`}
      role="listitem"
      data-selected={selected ? 'true' : undefined}
    >
      <button
        type="button"
        className={styles.rowSelect}
        aria-pressed={selected}
        onClick={() => onSelect(report.id)}
      >
        <span className={styles.reportRef}>R{report.id}</span>
        <span className={styles.reportMain}>
          <strong className={styles.reportTitle}>{report.title}</strong>
          <span className={styles.reportMeta}>
            <span suppressHydrationWarning>{weekStart} – {weekEnd}</span>
            <span aria-hidden="true">·</span>
            <span>Created <span suppressHydrationWarning>{createdAt}</span></span>
          </span>
        </span>
      </button>

      <div className={styles.rowActions}>
        <Link
          href={`/edit/${report.id}`}
          className={styles.iconAction}
          aria-label={`Edit ${report.title}`}
          title="Edit report"
        >
          <Pencil className="h-4 w-4" />
        </Link>
        <button
          type="button"
          className={`${styles.iconAction} ${styles.dangerAction}`}
          aria-label={`Delete ${report.title}`}
          title="Delete report"
          disabled={deleting}
          onClick={() => onDelete(report.id)}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <Link
          href={`/reports/${report.id}?audience=${audience}`}
          className={styles.iconAction}
          aria-label={`Open full review for ${report.title}`}
          title="Open full review"
        >
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  )
}
