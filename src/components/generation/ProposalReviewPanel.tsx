'use client'

import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Code2,
  Eye,
  FileDiff,
  LoaderCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PublicGenerationSummary } from '@/lib/generation/public-summary'
import type { ReviewableProposal } from '@/lib/generation/stream'
import { lineDiff } from '@/lib/generation/diff'

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
      <aside className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
        The proposed final version appears here after AI calls <code>propose_final_report</code>. Regular chat messages do not write directly to the report.
      </aside>
    )
  }

  return (
    <aside aria-label="Read-only proposal review" className="space-y-4 rounded-xl border border-border bg-background p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-semibold">Proposed final version</h3><p className="mt-0.5 text-xs text-muted-foreground">Read-only proposal review</p></div>
          <span className={`rounded-full px-2 py-1 text-xs ${proposal.status === 'accepted' ? 'bg-emerald-500/10 text-emerald-500' : proposal.status === 'superseded' ? 'bg-muted text-muted-foreground' : 'bg-amber-500/10 text-amber-500'}`}>{proposal.referenceChanged ? '参考已变化' : proposal.status === 'accepted' ? 'Accepted' : proposal.status === 'superseded' ? 'Superseded' : 'Pending review'}</span>
        </div>
        {!proposal.publicSummary && proposal.summary.length > 0 && <ul className="mt-3 space-y-1 text-xs text-muted-foreground">{proposal.summary.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}</ul>}
        {proposal.publicSummary && <PublicGenerationSummaryCard summary={proposal.publicSummary} />}
      </div>
      <div role="tablist" aria-label="Proposal views" className="flex rounded-lg bg-muted p-1">
        {([
          ['preview', Eye, 'Rendered preview'],
          ['source', Code2, 'Markdown source'],
          ['diff', FileDiff, 'Difference'],
        ] as const).map(([value, Icon, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} type="button" onClick={() => setTab(value)} disabled={value === 'diff' && proposal.baselineContent == null} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${tab === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'} disabled:opacity-40`}>
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
      </div>
      {tab === 'preview' && <div role="tabpanel" className="rounded-lg border border-border bg-[#141414] p-4 prose prose-sm prose-invert prose-report max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{proposal.content}</ReactMarkdown></div>}
      {tab === 'source' && <pre role="tabpanel" data-testid="proposal-markdown-source" className="max-h-[62vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-3 text-xs leading-5">{proposal.content}</pre>}
      {tab === 'diff' && proposal.baselineContent != null && (
        <div role="tabpanel" className="max-h-[62vh] overflow-auto rounded-lg border border-border bg-muted/20 p-3 font-mono text-xs leading-5">
          {diff.map((line, index) => <div key={index} data-diff-type={line.type} className={line.type === 'add' ? 'bg-emerald-500/10 text-emerald-500' : line.type === 'remove' ? 'bg-red-500/10 text-red-400' : 'text-muted-foreground'}>{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '} {line.value || ' '}</div>)}
        </div>
      )}
      {editable && proposal.status === 'pending' && <Button className="w-full" onClick={onAccept} disabled={accepting}>{accepting ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}Accept and save final version</Button>}
      <p className="text-xs text-muted-foreground">The current final version is unchanged until you accept. You can continue improving it in this session after saving.</p>
    </aside>
  )
}

function SummarySection({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium text-foreground">{title}</p>
      {children ?? <p>none</p>}
    </div>
  )
}

function PublicGenerationSummaryCard({ summary }: { summary: PublicGenerationSummary }) {
  return (
    <section className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-muted-foreground">
      <h4 className="font-semibold text-foreground">Public generation summary</h4>
      <p className="mt-2 leading-5">{summary.factBoundary.statement}</p>
      <p className="mt-1">This records model-explicit handling only; hidden reasoning: {summary.factBoundary.hiddenReasoning}.</p>
      <div className="mt-3 grid gap-3">
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
