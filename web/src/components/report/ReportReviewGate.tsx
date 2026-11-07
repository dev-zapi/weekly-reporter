import { Check, Circle, MessageSquareText, Pencil, ShieldCheck } from 'lucide-react'
import type { AudienceVariant, FinalStatus } from '@/lib/db/schema'
import styles from './report-workspace.module.css'

const audienceScopes: Record<AudienceVariant, string> = {
  leadership: 'Work + manual evidence',
  personal: 'All evidence',
}

export interface ReportReviewGateProps {
  audience: AudienceVariant
  sourceRevision: number
  snapshotCount: number
  sourceDraft: string
  hasFinal: boolean
  finalStatus: FinalStatus
  acceptedProposalId: number | null
  templateName: string | null
  aiStyle: string | null
  editable: boolean
  onOpenGeneration: () => void
  onEditFinal: () => void
}

/**
 * Real review/adoption context for one audience variant.
 *
 * The gate reports only persisted state: the frozen source revision, the
 * availability of a current final, and whether a generation proposal was
 * adopted. It never previews an adoption the user has not performed, and it
 * never treats the source draft as a candidate final.
 */
export function ReportReviewGate({
  audience,
  sourceRevision,
  snapshotCount,
  sourceDraft,
  hasFinal,
  finalStatus,
  acceptedProposalId,
  templateName,
  aiStyle,
  editable,
  onOpenGeneration,
  onEditFinal,
}: ReportReviewGateProps) {
  const sourceFrozen = sourceRevision > 0
  const adopted = finalStatus === 'current'
  const adoptionText = adopted
    ? acceptedProposalId
      ? `Proposal #${acceptedProposalId} accepted`
      : 'Final saved by the user'
    : finalStatus === 'stale'
      ? 'Retained, not current'
      : 'Not adopted'

  const steps = [
    {
      label: 'Snapshot frozen',
      value: snapshotCount > 0 ? `${snapshotCount} frozen events` : sourceFrozen ? `Revision r${sourceRevision}` : 'Legacy record · no snapshot',
      done: sourceFrozen,
    },
    {
      label: 'Source draft revision',
      value: `r${sourceRevision} · ${audienceScopes[audience]}`,
      done: Boolean(sourceDraft),
    },
    {
      label: 'Final content available',
      value: hasFinal ? `${finalStatus === 'stale' ? 'Stale' : 'Current'} final` : 'No final yet',
      done: hasFinal,
    },
    {
      label: 'Human adoption',
      value: adoptionText,
      done: adopted,
    },
  ]

  return (
    <aside className={styles.reviewPanel} aria-label="Report review gate">
      <div className={styles.reviewHeading}>
        <h2>Review gate</h2>
        <ShieldCheck size={18} aria-hidden="true" />
      </div>
      <p className={styles.reviewCopy}>
        The source draft remains the fact authority. A proposal becomes final only after your decision.
      </p>
      <ol className={styles.reviewSteps}>
        {steps.map((step, index) => (
          <li key={step.label} data-done={step.done ? 'true' : 'false'} className={styles.reviewStep}>
            {step.done ? <Check size={15} aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
            <span>
              <strong>
                {index + 1}. {step.label}
              </strong>
              <small>{step.value}</small>
            </span>
          </li>
        ))}
      </ol>
      <dl className={styles.provenance}>
        <div className={styles.provenanceRow}>
          <dt>Audience</dt>
          <dd>{audience === 'leadership' ? 'Leadership' : 'Personal'}</dd>
        </div>
        <div className={styles.provenanceRow}>
          <dt>Evidence scope</dt>
          <dd>{audienceScopes[audience]}</dd>
        </div>
        <div className={styles.provenanceRow}>
          <dt>Template snapshot</dt>
          <dd>{templateName ?? 'None'}</dd>
        </div>
        <div className={styles.provenanceRow}>
          <dt>AI style</dt>
          <dd>{aiStyle ?? 'None'}</dd>
        </div>
        <div className={styles.provenanceRow}>
          <dt>Accepted proposal</dt>
          <dd>{acceptedProposalId ? `#${acceptedProposalId}` : 'None'}</dd>
        </div>
      </dl>
      <div className={styles.reviewActions}>
        {editable && (
          <button type="button" className={styles.gateButton} onClick={onOpenGeneration}>
            <MessageSquareText size={16} aria-hidden="true" />
            {hasFinal ? 'Review proposals in AI chat' : 'Open AI generation'}
          </button>
        )}
        {editable && hasFinal && (
          <button type="button" className={styles.gateSecondary} onClick={onEditFinal}>
            <Pencil size={15} aria-hidden="true" />
            Edit final directly
          </button>
        )}
      </div>
      <p className={styles.reviewNote}>
        {hasFinal
          ? acceptedProposalId
            ? 'Acceptance and regeneration are recorded in the AI generation session.'
            : 'This final was saved directly by the user; no proposal was adopted.'
          : 'Adoption stays unavailable until a final exists. The source draft cannot be adopted on its own.'}
      </p>
    </aside>
  )
}
