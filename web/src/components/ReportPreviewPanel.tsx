import { useId } from 'react'
import { Link } from 'react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowRight, FileText } from 'lucide-react'
import type { AudienceVariant, FinalStatus } from '@/lib/db/schema'
import { formatSystemDate } from '@/lib/time-format'
import type { ReportSummary } from './ReportCard'
import styles from './ReportsLibrary.module.css'

/** One persisted audience variant as returned by GET /api/reports/:id. */
export interface ReportVariantPreview {
  variant: AudienceVariant
  sourceDraft: string
  finalContent: string | null
  finalStatus: FinalStatus
  sourceRevision: number
  templateName: string | null
}

export interface ReportDetail extends ReportSummary {
  variants: ReportVariantPreview[]
}

interface ReportPreviewPanelProps {
  report: ReportDetail | null
  audience: AudienceVariant
  onAudienceChange: (audience: AudienceVariant) => void
  loading: boolean
  error: string | null
  onRetry: () => void
}

const audiences: Array<{ key: AudienceVariant; label: string; scope: string }> = [
  { key: 'leadership', label: 'Leadership', scope: 'Work + manual evidence' },
  { key: 'personal', label: 'Personal', scope: 'All evidence' },
]

const statusLabels: Record<FinalStatus | 'missing', string> = {
  none: 'None',
  current: 'Current',
  stale: 'Stale',
  missing: 'No version',
}

/**
 * Persistent right-context preview. The selected audience variant is read
 * directly from the report detail response on every render, so one audience's
 * final can never stand in for the other.
 */
export function ReportPreviewPanel({
  report,
  audience,
  onAudienceChange,
  loading,
  error,
  onRetry,
}: ReportPreviewPanelProps) {
  const id = useId()
  const panelId = `${id}-panel`
  const variant = report?.variants.find((item) => item.variant === audience) ?? null
  const status: FinalStatus | 'missing' = !variant
    ? 'missing'
    : variant.finalContent
      ? variant.finalStatus === 'stale' ? 'stale' : 'current'
      : 'none'
  const audienceLabel = audiences.find((item) => item.key === audience)?.label ?? 'Audience'

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % audiences.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + audiences.length) % audiences.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = audiences.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    onAudienceChange(audiences[nextIndex].key)
    document.getElementById(`${id}-tab-${audiences[nextIndex].key}`)?.focus()
  }

  return (
    <>
      <div className={styles.audienceTabs} role="tablist" aria-label="Report audience">
        {audiences.map((item, index) => (
          <button
            key={item.key}
            id={`${id}-tab-${item.key}`}
            type="button"
            role="tab"
            aria-selected={audience === item.key}
            aria-controls={panelId}
            tabIndex={audience === item.key ? 0 : -1}
            className={audience === item.key ? styles.activeTab : undefined}
            onClick={() => onAudienceChange(item.key)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {item.label}
            <small>{item.scope}</small>
          </button>
        ))}
      </div>

      <section
        className={styles.previewPanel}
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${audience}`}
        aria-busy={loading}
      >
        {loading ? (
          <div className={styles.loadingState} role="status">
            <span className={styles.loadingLine} aria-hidden="true" />
            <strong>Loading report preview…</strong>
          </div>
        ) : error ? (
          <div className={styles.errorState} role="alert">
            <strong>Preview could not load</strong>
            <p>{error}</p>
            <button type="button" className={styles.stateAction} onClick={onRetry}>
              Retry preview
            </button>
          </div>
        ) : !report ? (
          <div className={styles.contextEmpty}>
            <FileText size={22} aria-hidden="true" />
            <strong>Select a report</strong>
            <p>Choose a numbered report to preview its audience final and review status.</p>
          </div>
        ) : (
          <>
            <div className={styles.previewTitle}>
              <div>
                <h2>{report.title}</h2>
                <p className={styles.previewPeriod} suppressHydrationWarning>
                  {formatSystemDate(report.weekStart)} – {formatSystemDate(report.weekEnd)}
                </p>
              </div>
              <span className={styles.statusBadge} data-status={status}>
                {statusLabels[status]}
              </span>
            </div>

            <div className={styles.previewMeta}>
              {variant ? (
                <>
                  <span>Source revision {variant.sourceRevision}</span>
                  <span>{variant.templateName || 'No template snapshot'}</span>
                </>
              ) : (
                <span>{audienceLabel} audience variant</span>
              )}
            </div>

            {!variant ? (
              <div className={styles.missingVariantState}>
                <FileText size={20} aria-hidden="true" />
                <strong>No {audienceLabel.toLowerCase()} version</strong>
                <p>
                  This report has no {audienceLabel.toLowerCase()} audience variant. The other
                  audience version is kept separate and is not shown here.
                </p>
              </div>
            ) : variant.finalContent ? (
              <div className={styles.documentBody}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{variant.finalContent}</ReactMarkdown>
              </div>
            ) : (
              <div className={styles.noFinalState}>
                <FileText size={20} aria-hidden="true" />
                <strong>No final report yet</strong>
                <p>
                  This audience variant has only a source draft. It is not a candidate final and is
                  never used as one; open full review to inspect the source.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      {report && !loading && !error && variant && (
        <Link
          to={`/reports/${report.id}?audience=${audience}`}
          className={styles.primaryButton}
        >
          Open full review
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      )}
    </>
  )
}
