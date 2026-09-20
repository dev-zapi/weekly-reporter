'use client'

import { memo, useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive,
  Bot,
  Check,
  Clipboard,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  User,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_GENERATION_INSTRUCTION } from '@/lib/generation/context'
import {
  type StreamingMarkdown,
} from '@/lib/generation/streaming-markdown'
import type { AudienceVariant, ReportVariant } from '@/lib/db/schema'
import { LEGACY_NO_SNAPSHOT, type CarryForwardSnapshot } from '@/lib/generation/carry-forward-snapshot'
import type { PlanState } from '@/lib/generation/plan'
import {
  type PublicGenerationSummary,
} from '@/lib/generation/public-summary'
import {
  isReportListToolResult,
  REPORT_LIST_TOOL_NAME,
  type ReportListToolResult,
} from '@/lib/generation/report-list-contract'
import { isReportContentToolResult, REPORT_CONTENT_TOOL_NAME, type ReportContentToolResult } from '@/lib/generation/report-content-contract'
import type { GenerationStreamEvent, ReviewableProposal } from '@/lib/generation/stream'
import { ProposalReviewPanel } from './generation/ProposalReviewPanel'
import { useStreamingReveal } from './generation/useStreamingReveal'

interface TemplateOption {
  id: string
  name: string
  content: string
  aiStyle?: string
}

interface StyleOption {
  key: string
  label: string
}

interface SessionSummary {
  id: number
  title: string
  status: 'active' | 'archived'
  variant: AudienceVariant
  sourceRevision: number
  templateName: string
  aiStyleLabel: string
  updatedAt: string
  latestTurn: { status: string } | null
  latestProposal: Proposal | null
}

interface MessagePart {
  id: number
  turnId: number | null
  sequence: number
  role: 'system' | 'user' | 'assistant' | 'tool' | 'application'
  partType: string
  content: string | null
  data: Record<string, unknown> | null
}

interface Turn {
  id: number
  status: 'working' | 'completed' | 'failed' | 'aborted'
  protocol: string
  model: string
  error: string | null
  createdAt: string
}

interface Proposal {
  id: number
  turnId: number
  content: string
  summary: string[]
  sourceRevision: number
  status: 'pending' | 'accepted' | 'superseded'
  createdAt: string | Date
  acceptedAt?: string | Date | null
  planState?: PlanState | null
  publicSummary?: PublicGenerationSummary | null
  baselineContent?: string | null
  referenceChanged?: boolean
}

interface SessionDetail extends SessionSummary {
  sourceDraftSnapshot: string
  sourceOverview: string
  templateId: string
  templateContent: string
  aiStyleKey: string
  aiStylePrompt: string
  systemPrompt: string
  toolRules: string
  planPolicy?: 'forbidden' | 'required' | null
  baselineFinalContent: string | null
  carryForwardSnapshot: CarryForwardSnapshot
  messages: MessagePart[]
  turns: Turn[]
  proposals: Proposal[]
  sourceIsCurrent: boolean
  activeTurn: Turn | null
  planJudgments?: Array<{ candidateId: string; judgment: string; reason: string; remainingAction: string | null }>
  planOverrides?: PlanOverrideRecord[]
  planOverrideState?: PlanOverrideItemState[]
  querySnapshots?: Array<{ id: number; toolName: string; calledAt: string | Date; trigger: string; resultCount: number; truncated: boolean; errorCode: string | null; previousSnapshotId: number | null; parameters: Record<string, unknown>; result: Record<string, unknown>; sourceAudience: string; sourceReportId: number; sourceUpdatedAt: string | Date | null; sourceWeekStart: string | null; sourceWeekEnd: string | null; sourceFinalStatus: string | null }>
  historicalReferencesChanged?: boolean
}

interface PlanOverrideRecord {
  id: number
  itemId: string
  action: 'keep' | 'drop' | 'rewrite' | 're-add'
  replacementText: string | null
  source: 'carry-forward' | 'this-week-new' | 'baseline'
  createdAt: string | Date
}

interface PlanOverrideItemState {
  itemId: string
  source: 'carry-forward' | 'this-week-new' | 'baseline'
  originalText: string
  effectiveText: string | null
  latestAction: 'keep' | 'drop' | 'rewrite' | 're-add'
  included: boolean
}

function toolStatusMessage(eventType: 'tool-input-delta' | 'tool-call' | 'tool-result', toolName: string): string {
  const reportList = toolName === REPORT_LIST_TOOL_NAME
  const reportContent = toolName === REPORT_CONTENT_TOOL_NAME
  if (eventType === 'tool-input-delta') return reportList ? 'Preparing report list query...' : reportContent ? 'Preparing report content query...' : 'Preparing proposed final version...'
  if (eventType === 'tool-call') return reportList ? 'Querying same-audience historical reports...' : reportContent ? 'Reading same-audience historical report...' : 'Calling propose_final_report...'
  return reportList ? 'Historical report list query completed.' : reportContent ? 'Historical report content query completed.' : 'Proposed final version submitted; awaiting review.'
}

function SystemContextCard({ detail, onRefresh }: { detail: SessionDetail; onRefresh?: (snapshotId: number) => void }) {
  const blocks = [
    ['Final report system prompt', detail.systemPrompt],
    [`AI style prompt · ${detail.aiStyleLabel}`, detail.aiStylePrompt],
    ['Tool rules', detail.toolRules],
  ] as const
  async function copy(value: string) {
    await navigator.clipboard.writeText(value)
    toast.success('Copied')
  }

  return (
    <div className="rounded-2xl border border-border bg-muted/15 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Bot className="h-4 w-4" />System message</div>
      <div className="space-y-2">
        {blocks.map(([label, content]) => (
          <details key={label} className="rounded-lg border border-border bg-background p-3">
            <summary className="cursor-pointer text-sm font-medium">{label}</summary>
            <div className="mt-3 flex justify-end"><Button variant="ghost" size="sm" onClick={() => void copy(content)}><Clipboard className="mr-1.5 h-3.5 w-3.5" />Copy</Button></div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{content}</pre>
          </details>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-border bg-background p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Source draft overview</p>
          <Dialog>
            <DialogTrigger render={<Button variant="outline" size="sm" />}><FileText className="mr-1.5 h-3.5 w-3.5" />View full source draft</DialogTrigger>
            <DialogContent className="max-h-[88vh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Full source draft used by this session</DialogTitle>
                <DialogDescription>This immutable snapshot is sent to AI and is the session’s only source of truth.</DialogDescription>
              </DialogHeader>
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6">{detail.sourceDraftSnapshot}</pre>
            </DialogContent>
          </Dialog>
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{detail.sourceOverview}</pre>
      </div>
      <details className="mt-2 rounded-lg border border-border bg-background p-3">
        <summary className="cursor-pointer text-sm font-medium">Template snapshot · {detail.templateName}</summary>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{detail.templateContent}</pre>
      </details>
      <CarryForwardSnapshotCard snapshot={detail.carryForwardSnapshot} />
      <details className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <summary className="cursor-pointer text-sm font-medium">Historical query snapshots · 历史参考·不可信</summary>
        <div className="mt-2 space-y-2 text-xs text-muted-foreground">
          {detail.historicalReferencesChanged && <p role="alert" className="text-amber-500">参考已变化。请显式启动新一轮生成以产生新提案。</p>}
          {(detail.querySnapshots ?? []).map((snapshot) => <div key={snapshot.id} className="flex items-center justify-between gap-2"><details className="min-w-0 flex-1"><summary className="cursor-pointer">#{snapshot.id} {snapshot.toolName} · {snapshot.resultCount} 项 · {snapshot.trigger}{snapshot.errorCode ? ` · ${snapshot.errorCode}` : ''}{snapshot.truncated ? ' · 截断' : ''}</summary><p className="mt-1">来源报告 {snapshot.sourceReportId} · 受众 {snapshot.sourceAudience} · 周期 {snapshot.sourceWeekStart ?? '-'} – {snapshot.sourceWeekEnd ?? '-'} · 状态 {snapshot.sourceFinalStatus ?? '-'} · 快照时间 {String(snapshot.calledAt)} · 历史参考·不可信</p><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">参数 {JSON.stringify(snapshot.parameters)}{snapshot.result && `\n摘要 ${JSON.stringify(snapshot.result).slice(0, 300)}`}</pre></details>{onRefresh && <Button variant="outline" size="sm" onClick={() => onRefresh(snapshot.id)}>刷新</Button>}</div>)}
          {(detail.querySnapshots ?? []).length === 0 && <p>尚未查询历史周报。</p>}
        </div>
      </details>
      <div className="mt-2 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
        Template plan contract: {detail.planPolicy === 'forbidden' ? '章节禁止' : '允许/需要下周计划（缺少时追加）'}
      </div>
    </div>
  )
}

function CarryForwardSnapshotCard({ snapshot }: { snapshot?: CarryForwardSnapshot }) {
  const normalized = snapshot ?? LEGACY_NO_SNAPSHOT
  const source = normalized.source
  return (
    <details className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" open>
      <summary className="cursor-pointer text-sm font-medium">Plan carry-forward snapshot · 历史参考·不可信</summary>
      <div className="mt-3 space-y-3 text-xs leading-5 text-muted-foreground">
        <p>This immutable historical reference is not a fact of the current report.</p>
        <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt>Snapshot status</dt><dd className="font-medium text-foreground">{normalized.status}</dd>
          <dt>Parse status</dt><dd>{normalized.parseStatus}{normalized.parseReason ? ` · ${normalized.parseReason}` : ''}</dd>
          <dt>Snapshot captured</dt><dd>{normalized.capturedAt ?? 'not captured'}</dd>
          <dt>Source</dt><dd>{source ? `${source.title} · ${source.weekStart} – ${source.weekEnd} · ${source.audience} · ${source.finalStatus}` : 'No exact previous-cycle source'}</dd>
          <dt>Proposal reference</dt><dd>{source?.acceptedProposalId ?? 'none'}</dd>
        </dl>
        {normalized.parseWarning && <p className="text-amber-500">{normalized.parseWarning}</p>}
        <div>
          <p className="mb-1 font-medium text-foreground">Plan source copy</p>
          <pre className="whitespace-pre-wrap break-words rounded border border-border bg-background p-2">{normalized.planText ?? '(none)'}</pre>
        </div>
        <div>
          <p className="mb-1 font-medium text-foreground">Candidates ({normalized.candidates.length})</p>
          {normalized.candidates.length > 0 ? (
            <ul className="space-y-1">
              {normalized.candidates.map((candidate) => <li key={candidate.candidateId}>[{candidate.candidateId}] {candidate.text} · {candidate.judgment ?? 'pending judgment'}</li>)}
            </ul>
          ) : <p>(none)</p>}
        </div>
        {normalized.reason && <p>Reason: {normalized.reason}</p>}
      </div>
    </details>
  )
}

function PlanOverrideRow({
  itemId,
  text,
  source,
  state,
  disabled,
  onAction,
}: {
  itemId: string
  text: string
  source: 'carry-forward' | 'this-week-new' | 'baseline'
  state?: PlanOverrideItemState
  disabled: boolean
  onAction: (action: PlanOverrideRecord['action'], itemId: string, text?: string) => Promise<boolean>
}) {
  const [rewriting, setRewriting] = useState(false)
  const [replacement, setReplacement] = useState(state?.effectiveText ?? text)
  const dropped = state?.latestAction === 'drop'
  const effectiveText = state?.effectiveText ?? text

  const SOURCE_LABELS = {
    'carry-forward': 'carry-forward',
    'baseline': 'baseline',
    'this-week-new': '本周新增'
  } as const

  const sourceLabel = SOURCE_LABELS[source]

  return (
    <li className="rounded-lg border border-border bg-background p-3" data-plan-item-id={itemId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`break-words text-sm ${dropped ? 'line-through text-muted-foreground' : ''}`}>{effectiveText || text}</p>
          <p className="mt-1 text-xs text-muted-foreground">[{itemId}] · {sourceLabel} · {state ? `${state.latestAction} → ${state.included ? 'included' : 'excluded'}` : 'no user override'}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {dropped ? (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => void onAction('re-add', itemId)}>Re-add</Button>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => void onAction('keep', itemId)}>Keep</Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setReplacement(effectiveText || text); setRewriting((value) => !value) }}>Rewrite</Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => void onAction('drop', itemId)}>Drop</Button>
            </>
          )}
        </div>
      </div>
      {rewriting && !dropped && (
        <div className="mt-2 flex gap-2">
          <Input aria-label={`Rewrite ${itemId}`} value={replacement} onChange={(event) => setReplacement(event.target.value)} disabled={disabled} />
          <Button size="sm" disabled={disabled || !replacement.trim()} onClick={async () => { if (await onAction('rewrite', itemId, replacement)) setRewriting(false) }}>Save rewrite</Button>
        </div>
      )}
    </li>
  )
}

function PlanOverridePanel({
  detail,
  disabled,
  saving,
  onAction,
}: {
  detail: SessionDetail
  disabled: boolean
  saving: boolean
  onAction: (action: PlanOverrideRecord['action'], itemId?: string, text?: string) => Promise<boolean>
}) {
  const [newItem, setNewItem] = useState('')
  const candidateItems = (detail.carryForwardSnapshot ?? LEGACY_NO_SNAPSHOT).candidates
  const overrideState = detail.planOverrideState ?? []
  const records = detail.planOverrides ?? []
  const newItems = overrideState.filter((item) => item.source === 'this-week-new')
  const baselineItems = overrideState.filter((item) => item.source === 'baseline')
  const stateByItem = new Map(overrideState.map((item) => [item.itemId, item]))
  const recordDisabled = disabled || saving

  return (
    <section aria-label="Plan overrides" className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div>
        <h3 className="text-sm font-semibold">Plan overrides</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Append-only keep, drop, rewrite, and re-add decisions for this generation session. The latest valid decision overrides later AI judgments.</p>
      </div>
      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Carry-forward candidates</p>
          {candidateItems.length > 0 ? (
            <ul className="space-y-2">
              {candidateItems.map((candidate) => (
                <PlanOverrideRow key={candidate.candidateId} itemId={candidate.candidateId} text={candidate.text} source="carry-forward" state={stateByItem.get(candidate.candidateId)} disabled={recordDisabled} onAction={(action, itemId, text) => onAction(action, itemId, text)} />
              ))}
            </ul>
          ) : <p className="text-xs text-muted-foreground">No carry-forward candidates.</p>}
        </div>
        {baselineItems.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Baseline items (from previous accepted proposal)</p>
            <ul className="space-y-2">
              {baselineItems.map((item) => (
                <PlanOverrideRow key={item.itemId} itemId={item.itemId} text={item.originalText} source="baseline" state={item} disabled={recordDisabled} onAction={(action, itemId, text) => onAction(action, itemId, text)} />
              ))}
            </ul>
          </div>
        )}
        {newItems.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">This-week additions</p>
            <ul className="space-y-2">
              {newItems.map((item) => (
                <PlanOverrideRow key={item.itemId} itemId={item.itemId} text={item.originalText} source="this-week-new" state={item} disabled={recordDisabled} onAction={(action, itemId, text) => onAction(action, itemId, text)} />
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Input aria-label="New this-week plan item" placeholder="Add a concise next-week plan item" value={newItem} onChange={(event) => setNewItem(event.target.value)} disabled={recordDisabled} />
          <Button size="sm" disabled={recordDisabled || !newItem.trim()} onClick={async () => { if (await onAction('keep', undefined, newItem)) setNewItem('') }}>Add item</Button>
        </div>
        <details className="rounded-lg border border-border bg-background p-3">
          <summary className="cursor-pointer text-xs font-medium">Append-only override history ({records.length})</summary>
          {records.length > 0 ? (
            <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
              {records.map((record) => <li key={record.id}>{new Date(record.createdAt).toLocaleString()} · [{record.itemId}] {record.action}{record.replacementText ? ` · ${record.replacementText}` : ''} · {record.source}</li>)}
            </ol>
          ) : <p className="mt-2 text-xs text-muted-foreground">No user overrides recorded.</p>}
        </details>
      </div>
    </section>
  )
}

function ReportListToolResultCard({ output, content, onRetry }: { output: ReportListToolResult; content: string | null; onRetry?: () => void }) {
  return (
    <div className="ml-11 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="h-4 w-4 text-amber-500" />
        <span className="font-medium">查询周报列表</span>
        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">历史参考·不可信</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{content}</p>
      {output.ok ? (
        <div className="mt-3 space-y-2">
          {output.items.length > 0 ? output.items.map((item) => (
            <div key={item.reportId} className="rounded-lg border border-border bg-background p-3">
              <p className="font-medium">来源：{item.title} <span className="text-xs text-muted-foreground">#{item.reportId}</span></p>
              <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
                <dt>周期</dt><dd>{item.weekStart} – {item.weekEnd}</dd>
                <dt>受众</dt><dd>{item.audience === 'leadership' ? '领导版' : '个人版'} · {item.audience}</dd>
                <dt>状态</dt><dd>{item.finalStatus}</dd>
                <dt>更新时间</dt><dd>{new Date(item.updatedAt).toLocaleString()}</dd>
                <dt>正文可用</dt><dd>{item.contentAvailable ? '是' : '否'}</dd>
              </dl>
              {item.warning ? <p role="alert" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{item.warning}</p> : null}
              {item.matches?.length ? (
                <details className="mt-2 rounded border border-border p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">查询命中 ({item.matches.length})</summary>
                  <div className="mt-2 space-y-2">
                    {item.matches.map((match, index) => (
                      <pre key={`${match.field}-${match.startLine ?? 0}-${index}`} className="whitespace-pre-wrap break-words text-xs">{match.field}{match.startLine ? ` · lines ${match.startLine}–${match.endLine}` : ''}\n{match.content}</pre>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          )) : <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">未找到符合条件的历史周报</p>}
          <details className="rounded-lg border border-border bg-background p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">规范化 appliedFilters</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(output.appliedFilters, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><p>{output.error.code} · {output.error.message}</p>{output.error.code === 'QUERY_FAILED' && onRetry ? <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重试历史查询</Button> : null}</div>
      )}
    </div>
  )
}

function ReportContentToolResultCard({ output, content, onRetry }: { output: ReportContentToolResult; content: string | null; onRetry?: () => void }) {
  return <div className="ml-11 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2"><Wrench className="h-4 w-4 text-amber-500" /><span className="font-medium">查询周报内容</span><span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">历史参考·不可信</span></div>
    <p className="mt-2 text-xs text-muted-foreground">{content}</p>
    {output.ok && output.found && <><dl className="mt-2 grid gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]"><dt>来源</dt><dd>{output.identity.title} · {output.identity.weekStart} – {output.identity.weekEnd}</dd><dt>受众/状态</dt><dd>{output.identity.audience} · {output.identity.finalStatus}{output.identity.isLegacy ? ' · legacy' : ''}</dd><dt>截断</dt><dd>{output.truncated ? '是' : '否'}{output.totalChars !== undefined ? ` · ${output.returnedChars}/${output.totalChars} 字符` : ''}</dd></dl>{output.identity.warning ? <p role="alert" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{output.identity.warning}</p> : null}{output.content ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 text-xs">{output.content}</pre> : output.matches?.map((match) => <pre key={`${match.startLine}-${match.endLine}`} className="mt-2 whitespace-pre-wrap break-words rounded border border-border bg-background p-2 text-xs">lines {match.startLine}–{match.endLine}\n{match.content}</pre>)}</>}
    {output.ok && !output.found && <p className="mt-2 text-xs text-muted-foreground">未找到可用周报</p>}
    {!output.ok && <div className="mt-2 text-xs text-destructive"><p>{output.error.code} · {output.error.message}</p>{output.error.code === 'QUERY_FAILED' && onRetry ? <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重试历史查询</Button> : null}</div>}
  </div>
}

function TranscriptPart({ part, onRetry }: { part: MessagePart; onRetry?: () => void }) {
  if (part.role === 'system' || part.partType === 'status') return null
  if (part.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground">{part.content}</div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><User className="h-4 w-4" /></div>
      </div>
    )
  }
  if (part.partType === 'reasoning') {
    return (
      <div className="ml-11 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
        <p className="mb-2 text-xs font-medium text-violet-400">Provider reasoning / thinking</p>
        <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{part.content}</div>
      </div>
    )
  }
  if (part.partType === 'tool-call' || part.partType === 'tool-result') {
    const toolName = typeof part.data?.toolName === 'string' ? part.data.toolName : ''
    if (part.partType === 'tool-result' && toolName === REPORT_LIST_TOOL_NAME && isReportListToolResult(part.data?.output)) {
      return <ReportListToolResultCard output={part.data.output} content={part.content} onRetry={onRetry} />
    }
    if (part.partType === 'tool-result' && toolName === REPORT_CONTENT_TOOL_NAME && isReportContentToolResult(part.data?.output)) {
      return <ReportContentToolResultCard output={part.data.output} content={part.content} onRetry={onRetry} />
    }
    return (
      <details className="ml-11 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <summary className="flex cursor-pointer items-center gap-2"><Wrench className="h-4 w-4" />{part.content}</summary>
      </details>
    )
  }
  if (part.partType === 'proposal-accepted') {
    return <div className="text-center text-xs text-emerald-500"><Check className="mr-1 inline h-3.5 w-3.5" />{part.content}</div>
  }
  if (part.partType === 'error') {
    return <div className="ml-11 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{part.content}</div>
  }
  if (part.role === 'assistant') {
    return (
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background"><Bot className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border bg-background px-4 py-3 prose dark:prose-invert prose-report max-w-none text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content ?? ''}</ReactMarkdown>
        </div>
      </div>
    )
  }
  return null
}

const RenderedMarkdownBlock = memo(function RenderedMarkdownBlock({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
})

function LiveAssistant({ reasoning, text, toolState, working }: { reasoning: string; text: StreamingMarkdown; toolState: string; working: boolean }) {
  const hasText = text.markdownBlocks.length > 0 || text.pendingChunks.length > 0
  if (!working && !reasoning && !hasText && !toolState) return null
  return (
    <div className="space-y-3">
      {reasoning && (
        <div className="ml-11 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
      <p className="mb-2 text-xs font-medium text-violet-400">Provider reasoning / thinking</p>
          <div className="live-reasoning-line text-sm leading-6 text-muted-foreground">
            <span className="live-reasoning-content">{reasoning}</span>
          </div>
        </div>
      )}
      {(hasText || working) && (
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background"><Bot className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1 space-y-3 rounded-2xl rounded-tl-sm border border-border bg-background px-4 py-3">
            {hasText && (
              <div className="prose dark:prose-invert prose-report max-w-none text-sm">
                {text.markdownBlocks.map((block, index) => <RenderedMarkdownBlock key={index} content={block} />)}
                {text.pendingChunks.length > 0 && (
                  <div className="streaming-markdown-pending">
                    {text.pendingChunks.map((chunk) => <span key={chunk.id} className="streaming-text-reveal">{chunk.text}</span>)}
                  </div>
                )}
              </div>
            )}
            {working && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Working...</p>}
            {toolState && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Wrench className="h-3.5 w-3.5" />{toolState}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

export function GenerationWorkspace({
  reportId,
  variant,
  reportVariant,
  templates,
  styles,
  editable,
  onAccepted,
}: {
  reportId: number
  variant: AudienceVariant
  reportVariant: ReportVariant
  templates: TemplateOption[]
  styles: StyleOption[]
  editable: boolean
  onAccepted: (variant: ReportVariant) => void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '')
  const [styleOverride, setStyleOverride] = useState(templates[0]?.aiStyle ?? '')
  const [composer, setComposer] = useState(DEFAULT_GENERATION_INSTRUCTION)
  const [streaming, setStreaming] = useState(false)
  const [liveTurnId, setLiveTurnId] = useState<number | null>(null)
  const [liveUser, setLiveUser] = useState('')
  const [liveProposal, setLiveProposal] = useState<ReviewableProposal | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [savingOverride, setSavingOverride] = useState(false)

  const {
    liveText,
    liveReasoning,
    liveToolState,
    transcriptRef,
    handleTranscriptScroll,
    queueLiveText,
    queueLiveReasoning,
    flushLiveReasoning,
    waitForTextQueue,
    resetLiveOutput,
    setLiveToolState,
    finalizeLiveText,
  } = useStreamingReveal({ detail, streaming, liveUser })

  const loadSessions = useCallback(async (preferredId?: number) => {
    const response = await fetch(`/api/reports/${reportId}/generation-sessions?variant=${variant}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to load generation sessions')
    const rows = (data.sessions ?? []) as SessionSummary[]
    setSessions(rows)
    setActiveSessionId((current) => {
      if (preferredId && rows.some((item) => item.id === preferredId)) return preferredId
      if (current && rows.some((item) => item.id === current)) return current
      return rows[0]?.id ?? null
    })
  }, [reportId, variant])

  const loadDetail = useCallback(async (sessionId: number, settleLiveStream = false) => {
    const response = await fetch(`/api/reports/${reportId}/generation-sessions/${sessionId}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to load session')
    setDetail(data)
    // Clear liveProposal after detail is set, so the component uses detail.proposals.at(-1)
    if (settleLiveStream) {
      setLiveProposal(null)
      setLiveTurnId(null)
      setLiveUser('')
      resetLiveOutput()
    }
  }, [reportId, resetLiveOutput])

  useEffect(() => {
    let cancelled = false
    async function initializeSessions() {
      try {
        const response = await fetch(`/api/reports/${reportId}/generation-sessions?variant=${variant}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to load generation sessions')
        if (cancelled) return
        const rows = (data.sessions ?? []) as SessionSummary[]
        setSessions(rows)
        setActiveSessionId(rows[0]?.id ?? null)
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load generation sessions')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void initializeSessions()
    return () => { cancelled = true }
  }, [reportId, variant])

  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    async function fetchDetail() {
      try {
        const response = await fetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to load session')
        if (!cancelled) setDetail(data)
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load session')
      }
    }
    void fetchDetail()
    return () => { cancelled = true }
  }, [activeSessionId, reportId])

  async function streamTurn(sessionId: number, message: string) {
    setStreaming(true)
    setLiveTurnId(null)
    setLiveUser(message)
    resetLiveOutput()
    setLiveProposal(null)
    try {
      const response = await fetch(`/api/reports/${reportId}/generation-sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to start AI generation')
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      const handle = (event: GenerationStreamEvent) => {
        if (event.type === 'start') setLiveTurnId(event.turnId)
        else if (event.type === 'reasoning-delta') queueLiveReasoning(event.text)
        else if (event.type === 'text-delta') queueLiveText(event.text)
        else if (event.type === 'tool-input-delta') setLiveToolState(toolStatusMessage(event.type, event.toolName))
        else if (event.type === 'tool-call') setLiveToolState(toolStatusMessage(event.type, event.toolName))
        else if (event.type === 'tool-result') setLiveToolState(toolStatusMessage(event.type, event.toolName))
        else if (event.type === 'proposal') setLiveProposal(event.proposal)
        else if (event.type === 'error') throw new Error(event.message)
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) handle(JSON.parse(line) as GenerationStreamEvent)
      }
      if (pending.trim()) handle(JSON.parse(pending) as GenerationStreamEvent)
      flushLiveReasoning()
      await waitForTextQueue()
      finalizeLiveText()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await Promise.all([loadDetail(sessionId, true), loadSessions(sessionId)])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI generation failed')
      flushLiveReasoning()
      await waitForTextQueue()
      finalizeLiveText()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await loadDetail(sessionId, true).catch(() => undefined)
    } finally {
      setStreaming(false)
      setLiveTurnId(null)
      setLiveUser('')
      resetLiveOutput()
    }
  }

  async function createSession() {
    if (!templateId || !composer.trim()) return
    setCreating(true)
    try {
      const response = await fetch(`/api/reports/${reportId}/generation-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, templateId, styleOverride: styleOverride || undefined }),
      })
      const session = await response.json()
      if (!response.ok) throw new Error(session.error || 'Failed to create generation session')
      setActiveSessionId(session.id)
      await loadSessions(session.id)
      await loadDetail(session.id)
      const initialMessage = composer.trim()
      setComposer('')
      await streamTurn(session.id, initialMessage)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create generation session')
    } finally {
      setCreating(false)
    }
  }

  async function sendMessage(message = composer) {
    if (!activeSessionId || !message.trim() || streaming) return
    setComposer('')
    await streamTurn(activeSessionId, message.trim())
  }

  async function stopTurn() {
    const turnId = liveTurnId ?? detail?.activeTurn?.id
    if (!activeSessionId || !turnId) return
    const response = await fetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}/turns/${turnId}/stop`, { method: 'POST' })
    if (!response.ok) toast.error('Failed to stop generation')
  }

  async function acceptProposal(proposal: ReviewableProposal) {
    if (!activeSessionId) return
    if (reportVariant.finalContent && !confirm('Accepting will replace the current final version. Continue?')) return
    setAccepting(true)
    try {
      const response = await fetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}/proposals/${proposal.id}/accept`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save proposed final version')
      onAccepted(data.variant)
      setLiveProposal(null) // Clear live proposal so we show the updated proposal from detail
      await Promise.all([loadDetail(activeSessionId), loadSessions(activeSessionId)])
      toast.success('Final version saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save proposed final version')
    } finally {
      setAccepting(false)
    }
  }

  async function recordPlanOverride(action: PlanOverrideRecord['action'], itemId?: string, text?: string) {
    if (!activeSessionId || streaming) return false
    setSavingOverride(true)
    try {
      const response = await fetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}/plan-overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, itemId, text }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to record plan override')
      setLiveProposal(null) // Clear live proposal since pending proposals are superseded
      await Promise.all([loadDetail(activeSessionId), loadSessions(activeSessionId)])
      toast.success(`Plan override recorded: ${action}`)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to record plan override')
      return false
    } finally {
      setSavingOverride(false)
    }
  }

  async function archiveSession() {
    if (!activeSessionId || !confirm('After archiving, the record remains viewable but cannot continue chatting. Archive this session?')) return
    const response = await fetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}`, { method: 'DELETE' })
    const data = await response.json()
    if (!response.ok) return toast.error(data.error || 'Archive failed')
    await loadSessions(activeSessionId)
    await loadDetail(activeSessionId)
  }

  async function renameSession() {
    if (!activeSessionId || !detail) return
    const title = prompt('Session title', detail.title)
    if (!title || title.trim() === detail.title) return
    const response = await fetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const data = await response.json()
    if (!response.ok) return toast.error(data.error || 'Rename failed')
    await Promise.all([loadDetail(activeSessionId), loadSessions(activeSessionId)])
  }

  const proposal = liveProposal ?? detail?.proposals.at(-1) ?? null
  const lastTurn = detail?.turns.at(-1)
  const lastUserMessage = lastTurn ? detail?.messages.find((part) => part.turnId === lastTurn.id && part.role === 'user' && part.partType === 'text')?.content : null
  const noProposalAfterLastTurn = Boolean(lastTurn?.status === 'completed' && !detail?.proposals.some((item) => item.turnId === lastTurn.id))
  const canChat = editable && detail?.status === 'active' && detail.sourceIsCurrent

  if (loading) return <div className="py-12 text-center text-sm text-muted-foreground">Loading generation sessions...</div>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          <select className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={activeSessionId ?? ''} onChange={(event) => { const value = event.target.value; setActiveSessionId(value ? Number(value) : null); if (!value) setDetail(null) }}>
            <option value="">New generation session</option>
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.status === 'archived' ? '[Archived] ' : ''}{session.title}</option>)}
          </select>
        </div>
        {editable && <Button variant="outline" size="sm" onClick={() => { setActiveSessionId(null); setDetail(null); setComposer(DEFAULT_GENERATION_INSTRUCTION) }}><Plus className="mr-1.5 h-4 w-4" />New session</Button>}
      </div>

      {!activeSessionId ? (
        editable ? (
          <div className="mx-auto max-w-3xl space-y-5 rounded-xl border border-border p-5">
            <div><h2 className="font-semibold">Create AI generation session</h2><p className="mt-1 text-sm text-muted-foreground">The current source draft, template, style, and system prompts are locked when you create the session, then the initial instruction below is sent.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="generation-template">Template</Label><select id="generation-template" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={templateId} onChange={(event) => { setTemplateId(event.target.value); const selected = templates.find((item) => item.id === event.target.value); setStyleOverride(selected?.aiStyle ?? '') }}><option value="">Select a template</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
              <div className="space-y-2"><Label htmlFor="generation-style">AI style</Label><select id="generation-style" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={styleOverride} onChange={(event) => setStyleOverride(event.target.value)}><option value="">Use template default style</option>{styles.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
            </div>
            <div className="space-y-2"><Label htmlFor="initial-generation-message">Initial instruction (editable)</Label><Textarea id="initial-generation-message" className="min-h-28" value={composer} onChange={(event) => setComposer(event.target.value)} /></div>
            <Button className="w-full" onClick={() => void createSession()} disabled={creating || !templateId || !composer.trim()}>{creating ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}Create session and send</Button>
          </div>
        ) : <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">This version has no AI generation sessions.</div>
      ) : !detail ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading chat...</div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,44%)]">
          <section className="min-w-0 rounded-xl border border-border bg-muted/5">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-semibold">{detail.title}</h2>{detail.status === 'archived' && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Archived</span>}</div><p className="mt-0.5 text-xs text-muted-foreground">{detail.templateName} · {detail.aiStyleLabel} · Source r{detail.sourceRevision}{detail.turns.at(-1) ? ` · ${detail.turns.at(-1)?.protocol}/${detail.turns.at(-1)?.model}` : ''}</p></div>
              {editable && <div className="flex gap-1"><Button variant="ghost" size="icon-sm" title="Rename" onClick={() => void renameSession()}><Pencil /></Button>{detail.status === 'active' && <Button variant="ghost" size="icon-sm" title="Archive" onClick={() => void archiveSession()} disabled={streaming}><Archive /></Button>}</div>}
            </div>
              {!detail.sourceIsCurrent && <div className="border-b border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-500">The source draft has changed. This session is retained for audit; create a new session from the latest draft.</div>}
            <div ref={transcriptRef} onScroll={handleTranscriptScroll} className="generation-transcript max-h-[calc(100vh-15rem)] min-h-[520px] space-y-4 overflow-y-auto p-4">
              <SystemContextCard detail={detail} onRefresh={(snapshotId) => { if (snapshotId) void (async () => { const response = await fetch(`/api/reports/${reportId}/generation-sessions/${detail.id}/query-snapshots/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId }) }); if (!response.ok) { toast.error('刷新历史查询失败'); return } await loadDetail(detail.id) })() }} />
              <PlanOverridePanel detail={detail} disabled={!canChat || streaming} saving={savingOverride} onAction={recordPlanOverride} />
              {detail.messages.map((part) => <TranscriptPart key={part.id} part={part} onRetry={part.partType === 'tool-result' ? () => { const message = detail.messages.filter((item) => item.role === 'user').at(-1)?.content; if (message) void streamTurn(detail.id, message) } : undefined} />)}
              {liveUser && <TranscriptPart part={{ id: -1, turnId: liveTurnId, sequence: Number.MAX_SAFE_INTEGER, role: 'user', partType: 'text', content: liveUser, data: null }} />}
              <LiveAssistant reasoning={liveReasoning} text={liveText} toolState={liveToolState} working={streaming || Boolean(detail.activeTurn && !liveTurnId)} />
              {noProposalAfterLastTurn && !streaming && canChat && <div className="ml-11 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">No proposed final version was submitted this turn. <Button variant="link" className="h-auto px-1" onClick={() => void sendMessage('Turn the current discussion into a complete proposed final version and submit it with propose_final_report.')}>Submit current version</Button></div>}
              {lastTurn?.status === 'failed' && !streaming && canChat && lastUserMessage && <div className="ml-11 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">Generation failed this turn. <Button variant="link" className="h-auto px-1 text-destructive" onClick={() => void sendMessage(lastUserMessage)}>Retry turn</Button></div>}
            </div>
            {canChat && (
              <div className="border-t border-border p-3">
                <Textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Ask AI to revise, answer a question, or submit the current version..." disabled={streaming} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage() } }} />
                <div className="mt-2 flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Enter to send, Shift+Enter for a new line</p>{streaming ? <Button variant="outline" size="sm" onClick={() => void stopTurn()}><Square className="mr-1.5 h-3.5 w-3.5" />Stop</Button> : <Button size="sm" onClick={() => void sendMessage()} disabled={!composer.trim()}><Send className="mr-1.5 h-3.5 w-3.5" />Send</Button>}</div>
              </div>
            )}
          </section>
          <ProposalReviewPanel proposal={proposal} editable={editable && detail.sourceIsCurrent} accepting={accepting} onAccept={() => proposal && void acceptProposal(proposal)} />
        </div>
      )}
    </div>
  )
}
