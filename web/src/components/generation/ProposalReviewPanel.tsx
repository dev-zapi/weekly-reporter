import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Circle,
  Code2,
  Eye,
  FileDiff,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react'
import type { PublicGenerationSummary } from '@/lib/generation/public-summary'
import type { ReviewableProposal } from '@/lib/generation/stream'
import { lineDiff } from '@/lib/generation/diff'
import styles from './generation.module.css'

type ReviewTab = 'preview' | 'source' | 'diff'

export function ProposalReviewPanel({
  proposal,
  editable,
  accepting,
  onAccept,
}: {
  proposal: ReviewableProposal | null
  editable: boolean
  accepting: boolean
  onAccept: () => void
}) {
  const [tab, setTab] = useState<ReviewTab>('preview')
  const diff = useMemo(() => proposal && proposal.baselineContent != null ? lineDiff(proposal.baselineContent, proposal.content) : [], [proposal])
  if (!proposal) {
    return (
      <div className={styles.proposalEmpty}>
        The proposed final version appears here after AI calls <code>propose_final_report</code>. Regular chat messages
        do not write directly to the report.
      </div>
    )
  }

  const statusLabel = proposal.referenceChanged
    ? '参考已变化'
    : proposal.status === 'accepted'
      ? 'Accepted'
      : proposal.status === 'superseded'
        ? 'Superseded'
        : 'Pending review'
  const adoptionLabel = proposal.status === 'accepted'
    ? 'Adopted by the user'
    : proposal.status === 'superseded'
      ? 'Replaced by a later proposal'
      : editable
        ? 'Awaiting the user decision'
        : 'Read-only review'

  return (
    <div className={styles.proposalPanel}>
      <div className={styles.proposalHeader}>
        <div>
          <h3 className={styles.proposalTitle}>Proposed final version</h3>
          <p className={styles.proposalSubtitle}>Read-only proposal review</p>
        </div>
        <span
          className={`${styles.statusPill} ${
            proposal.status === 'accepted'
              ? styles.statusAccepted
              : proposal.status === 'superseded'
                ? styles.statusSuperseded
                : styles.statusPending
          }`}
        >
          {statusLabel}
        </span>
      </div>

      {!proposal.publicSummary && proposal.summary.length > 0 && (
        <ul className={styles.proposalSummary}>
          {proposal.summary.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}
        </ul>
      )}
      {proposal.publicSummary && <PublicGenerationSummaryCard summary={proposal.publicSummary} />}

      <ul className={styles.reviewChecklist} aria-label="Proposal review state">
        <li><ShieldCheck size={13} aria-hidden="true" />Source revision r{proposal.sourceRevision}</li>
        <li>
          {proposal.baselineContent != null ? <Check size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
          {proposal.baselineContent != null ? 'Baseline comparison available' : 'No baseline captured for this proposal'}
        </li>
        <li>
          {proposal.status === 'accepted' ? <Check size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
          {adoptionLabel}
        </li>
      </ul>

      <div role="tablist" aria-label="Proposal views" className={styles.proposalTabs}>
        {([
          ['preview', Eye, 'Rendered preview'],
          ['source', Code2, 'Markdown source'],
          ['diff', FileDiff, 'Difference'],
        ] as const).map(([value, Icon, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            type="button"
            onClick={() => setTab(value)}
            disabled={value === 'diff' && proposal.baselineContent == null}
            className={`${styles.proposalTab} ${tab === value ? styles.proposalTabActive : ''}`}
          >
            <Icon className={styles.tabIcon} size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'preview' && (
        <div role="tabpanel" className={styles.proposalPreview}>
          <div className={styles.proposalDocument} data-testid="proposal-document">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{proposal.content}</ReactMarkdown>
          </div>
        </div>
      )}
      {tab === 'source' && (
        <pre role="tabpanel" data-testid="proposal-markdown-source" className={styles.proposalSource}>{proposal.content}</pre>
      )}
      {tab === 'diff' && proposal.baselineContent != null && (
        <div role="tabpanel" className={styles.diffBox}>
          {diff.map((line, index) => (
            <div
              key={index}
              data-diff-type={line.type}
              className={`${styles.diffLine} ${line.type === 'add' ? styles.diffAdd : line.type === 'remove' ? styles.diffRemove : styles.diffContext}`}
            >
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '} {line.value || ' '}
            </div>
          ))}
        </div>
      )}

      {editable && proposal.status === 'pending' && (
        <button type="button" className={styles.acceptButton} onClick={onAccept} disabled={accepting}>
          {accepting
            ? <LoaderCircle className={styles.tabIcon} size={16} aria-hidden="true" />
            : <Check className={styles.tabIcon} size={16} aria-hidden="true" />}
          Accept and save final version
        </button>
      )}
      <p className={styles.proposalNote}>
        The current final version is unchanged until you accept. You can continue improving it in this session after
        saving.
      </p>
    </div>
  )
}

function SummarySection({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className={styles.summarySection}>
      <p>{title}</p>
      {children ?? <p>none</p>}
    </div>
  )
}

function PublicGenerationSummaryCard({ summary }: { summary: PublicGenerationSummary }) {
  return (
    <section className={styles.publicSummaryCard}>
      <h4 className={styles.publicSummaryHeading}>Public generation summary</h4>
      <p className={styles.publicSummaryCopy}>{summary.factBoundary.statement}</p>
      <p className={styles.publicSummaryHint}>
        This records model-explicit handling only; hidden reasoning: {summary.factBoundary.hiddenReasoning}.
      </p>
      <div className={styles.summaryGrid}>
        <SummarySection title="Model-explicit handling">{summary.modelHandling.length > 0 ? <ul className="list-disc space-y-1 pl-4">{summary.modelHandling.map((item) => <li key={item}>{item}</li>)}</ul> : undefined}</SummarySection>
        <SummarySection title="Historical references">{summary.historicalReferences.length > 0 ? <ul className="space-y-1">{summary.historicalReferences.map((item) => <li key={`${item.kind}-${item.reportId}`}>{item.title} · {item.weekStart} – {item.weekEnd} · {item.audience} · {item.isLegacy ? 'legacy' : item.finalStatus} · 历史参考·不可信{item.warning ? <span role="alert" className="ml-1 text-amber-600 dark:text-amber-400">· {item.warning}</span> : null}</li>)}</ul> : undefined}</SummarySection>
        <SummarySection title="Tool status">{summary.toolStatuses.length > 0 ? <ul className="space-y-1">{summary.toolStatuses.map((item) => <li key={`${item.toolName}-${item.status}`}>{item.toolName} · {item.status}{item.detail !== 'none' ? ` · ${item.detail}` : ''}</li>)}</ul> : undefined}</SummarySection>
        <SummarySection title="Failure states">{summary.failureStates.length > 0 ? <ul className="space-y-1">{summary.failureStates.map((item) => <li key={`${item.scope}-${item.code}`}>{item.code} · {item.message}</li>)}</ul> : undefined}</SummarySection>
        <SummarySection title="Truncation states">{summary.truncationStates.length > 0 ? <ul className="space-y-1">{summary.truncationStates.map((item) => <li key={`${item.scope}-${item.omittedCount}`}>{item.message}</li>)}</ul> : undefined}</SummarySection>
        <SummarySection title="Change summary">{summary.changeSummary.length > 0 ? <ul className="list-disc space-y-1 pl-4">{summary.changeSummary.map((item) => <li key={item}>{item}</li>)}</ul> : undefined}</SummarySection>
      </div>
    </section>
  )
}
