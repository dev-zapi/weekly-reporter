import { apiFetch, traceSuffix } from '@/lib/api-client'

import { memo, useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
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
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_GENERATION_INSTRUCTION } from '@/lib/generation/context'
import {
  type StreamingMarkdown,
} from '@/lib/generation/streaming-markdown'
import type { AudienceVariant, ReportVariant } from '@/lib/db/schema'
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
import styles from './generation/generation.module.css'

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
  baselineFinalContent: string | null
  messages: MessagePart[]
  turns: Turn[]
  proposals: Proposal[]
  sourceIsCurrent: boolean
  activeTurn: Turn | null
  querySnapshots?: Array<{ id: number; toolName: string; calledAt: string | Date; trigger: string; resultCount: number; truncated: boolean; errorCode: string | null; previousSnapshotId: number | null; parameters: Record<string, unknown>; result: Record<string, unknown>; sourceAudience: string; sourceReportId: number; sourceUpdatedAt: string | Date | null; sourceWeekStart: string | null; sourceWeekEnd: string | null; sourceFinalStatus: string | null }>
  historicalReferencesChanged?: boolean
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
    <div className={styles.systemCard}>
      <div className={styles.systemHeading}><Bot size={15} aria-hidden="true" />System message</div>
      <div>
        {blocks.map(([label, content]) => (
          <details key={label} className={styles.systemDetails}>
            <summary>{label}</summary>
            <div className={styles.systemBlockHeader}>
              <span />
              <button type="button" className={styles.ghostButton} onClick={() => void copy(content)}>
                <Clipboard size={14} aria-hidden="true" />
                Copy
              </button>
            </div>
            <pre className={styles.systemPre}>{content}</pre>
          </details>
        ))}
      </div>
      <div className={styles.overviewCard}>
        <div className={styles.overviewHeader}>
          <p>Source draft overview</p>
          <Dialog>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>
              <FileText className={styles.tabIcon} size={14} aria-hidden="true" />
              View full source draft
            </DialogTrigger>
            <DialogContent className="max-h-[88vh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Full source draft used by this session</DialogTitle>
                <DialogDescription>This immutable snapshot is sent to AI and is the session’s only source of truth.</DialogDescription>
              </DialogHeader>
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6">{detail.sourceDraftSnapshot}</pre>
            </DialogContent>
          </Dialog>
        </div>
        <pre className={styles.systemPre}>{detail.sourceOverview}</pre>
      </div>
      <details className={styles.systemDetails}>
        <summary>Template snapshot · {detail.templateName}</summary>
        <pre className={styles.systemPre}>{detail.templateContent}</pre>
      </details>
      <details className={styles.snapshotDetails}>
        <summary>Historical query snapshots · 历史参考·不可信</summary>
        <div className={styles.snapshotBody}>
          {detail.historicalReferencesChanged && <p role="alert">参考已变化。请显式启动新一轮生成以产生新提案。</p>}
          {(detail.querySnapshots ?? []).map((snapshot) => (
            <div key={snapshot.id} className={styles.snapshotRow}>
              <details>
                <summary>
                  #{snapshot.id} {snapshot.toolName} · {snapshot.resultCount} 项 · {snapshot.trigger}
                  {snapshot.errorCode ? ` · ${snapshot.errorCode}` : ''}
                  {snapshot.truncated ? ' · 截断' : ''}
                </summary>
                <p>
                  来源报告 {snapshot.sourceReportId} · 受众 {snapshot.sourceAudience} · 周期 {snapshot.sourceWeekStart ?? '-'} – {snapshot.sourceWeekEnd ?? '-'} ·
                  状态 {snapshot.sourceFinalStatus ?? '-'} · 快照时间 {String(snapshot.calledAt)} · 历史参考·不可信
                </p>
                <pre>
                  参数 {JSON.stringify(snapshot.parameters)}
                  {snapshot.result && `\n摘要 ${JSON.stringify(snapshot.result).slice(0, 300)}`}
                </pre>
              </details>
              {onRefresh && (
                <button type="button" className={styles.secondaryButton} onClick={() => onRefresh(snapshot.id)}>刷新</button>
              )}
            </div>
          ))}
          {(detail.querySnapshots ?? []).length === 0 && <p>尚未查询历史周报。</p>}
        </div>
      </details>
    </div>
  )
}

function ReportListToolResultCard({ output, content, onRetry }: { output: ReportListToolResult; content: string | null; onRetry?: () => void }) {
  return (
    <div className={styles.toolCard}>
      <div className={styles.toolCardHeader}>
        <Wrench size={14} aria-hidden="true" />
        <strong>查询周报列表</strong>
        <span className={styles.toolBadge}>历史参考·不可信</span>
      </div>
      <p className={styles.toolCopy}>{content}</p>
      {output.ok ? (
        <div className={styles.toolGrid}>
          {output.items.length > 0 ? output.items.map((item) => (
            <div key={item.reportId} className={styles.toolItem}>
              <p className={styles.toolItemTitle}>
                来源：{item.title} <span>#{item.reportId}</span>
              </p>
              <dl className={styles.toolMeta}>
                <dt>周期</dt><dd>{item.weekStart} – {item.weekEnd}</dd>
                <dt>受众</dt><dd>{item.audience === 'leadership' ? '领导版' : '个人版'} · {item.audience}</dd>
                <dt>状态</dt><dd>{item.finalStatus}</dd>
                <dt>更新时间</dt><dd>{new Date(item.updatedAt).toLocaleString()}</dd>
                <dt>正文可用</dt><dd>{item.contentAvailable ? '是' : '否'}</dd>
              </dl>
              {item.warning ? <p role="alert" className={styles.toolCopy}>{item.warning}</p> : null}
              {item.matches?.length ? (
                <details className={styles.systemDetails}>
                  <summary>查询命中 ({item.matches.length})</summary>
                  <div className={styles.toolGrid}>
                    {item.matches.map((match, index) => (
                      <pre key={`${match.field}-${match.startLine ?? 0}-${index}`} className={styles.toolPre}>
                        {match.field}{match.startLine ? ` · lines ${match.startLine}–${match.endLine}` : ''}
                        {'\n'}{match.content}
                      </pre>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          )) : <p className={styles.toolCopy}>未找到符合条件的历史周报</p>}
          <details className={styles.systemDetails}>
            <summary>规范化 appliedFilters</summary>
            <pre className={styles.toolPre}>{JSON.stringify(output.appliedFilters, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <div className={styles.toolError}>
          <p>{output.error.code} · {output.error.message}</p>
          {output.error.code === 'QUERY_FAILED' && onRetry ? (
            <button type="button" className={styles.ghostButton} onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />
              重试历史查询
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function ReportContentToolResultCard({ output, content, onRetry }: { output: ReportContentToolResult; content: string | null; onRetry?: () => void }) {
  return (
    <div className={styles.toolCard}>
      <div className={styles.toolCardHeader}>
        <Wrench size={14} aria-hidden="true" />
        <strong>查询周报内容</strong>
        <span className={styles.toolBadge}>历史参考·不可信</span>
      </div>
      <p className={styles.toolCopy}>{content}</p>
      {output.ok && output.found && (
        <>
          <dl className={styles.toolMeta}>
            <dt>来源</dt><dd>{output.identity.title} · {output.identity.weekStart} – {output.identity.weekEnd}</dd>
            <dt>受众/状态</dt><dd>{output.identity.audience} · {output.identity.finalStatus}{output.identity.isLegacy ? ' · legacy' : ''}</dd>
            <dt>截断</dt><dd>{output.truncated ? '是' : '否'}{output.totalChars !== undefined ? ` · ${output.returnedChars}/${output.totalChars} 字符` : ''}</dd>
          </dl>
          {output.identity.warning ? <p role="alert" className={styles.toolCopy}>{output.identity.warning}</p> : null}
          {output.content
            ? <pre className={styles.toolPre}>{output.content}</pre>
            : output.matches?.map((match) => (
              <pre key={`${match.startLine}-${match.endLine}`} className={styles.toolPre}>
                lines {match.startLine}–{match.endLine}
                {'\n'}{match.content}
              </pre>
            ))}
        </>
      )}
      {output.ok && !output.found && <p className={styles.toolCopy}>未找到可用周报</p>}
      {!output.ok && (
        <div className={styles.toolError}>
          <p>{output.error.code} · {output.error.message}</p>
          {output.error.code === 'QUERY_FAILED' && onRetry ? (
            <button type="button" className={styles.ghostButton} onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />
              重试历史查询
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function TranscriptPart({ part, onRetry }: { part: MessagePart; onRetry?: () => void }) {
  if (part.role === 'system' || part.partType === 'status') return null
  if (part.role === 'user') {
    return (
      <div className={styles.userRow}>
        <div className={styles.userBubble}>{part.content}</div>
        <div className={`${styles.avatar} ${styles.avatarUser}`}><User size={15} aria-hidden="true" /></div>
      </div>
    )
  }
  if (part.partType === 'reasoning') {
    return (
      <div className={styles.reasoningCard}>
        <p className={styles.reasoningLabel}>Provider reasoning / thinking</p>
        <div className={styles.assistantBody}>{part.content}</div>
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
      <details className={styles.toolDetails}>
        <summary className={styles.toolSummary}><Wrench size={14} aria-hidden="true" />{part.content}</summary>
      </details>
    )
  }
  if (part.partType === 'proposal-accepted') {
    return <div className={styles.acceptedLine}><Check size={13} aria-hidden="true" /> {part.content}</div>
  }
  if (part.partType === 'error') {
    return <div className={styles.errorCard}>{part.content}</div>
  }
  if (part.role === 'assistant') {
    return (
      <div className={styles.assistantRow}>
        <div className={`${styles.avatar} ${styles.avatarAssistant}`}><Bot size={15} aria-hidden="true" /></div>
        <div className={styles.assistantCard}>
          <div className={styles.assistantBody}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content ?? ''}</ReactMarkdown>
          </div>
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
    <div className={styles.liveGroup}>
      {reasoning && (
        <div className={styles.reasoningCard}>
          <p className={styles.reasoningLabel}>Provider reasoning / thinking</p>
          <div className={`live-reasoning-line ${styles.assistantBody}`}>
            <span className="live-reasoning-content">{reasoning}</span>
          </div>
        </div>
      )}
      {(hasText || working) && (
        <div className={styles.assistantRow}>
          <div className={`${styles.avatar} ${styles.avatarAssistant}`}><Bot size={15} aria-hidden="true" /></div>
          <div className={styles.assistantCard}>
            {hasText && (
              <div className={styles.assistantBody}>
                {text.markdownBlocks.map((block, index) => <RenderedMarkdownBlock key={index} content={block} />)}
                {text.pendingChunks.length > 0 && (
                  <div className="streaming-markdown-pending">
                    {text.pendingChunks.map((chunk) => <span key={chunk.id} className="streaming-text-reveal">{chunk.text}</span>)}
                  </div>
                )}
              </div>
            )}
            {working && <p role="status" className={styles.composerHint}><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Working...</p>}
            {toolState && <p className={styles.composerHint}><Wrench size={13} aria-hidden="true" /> {toolState}</p>}
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
  styles: styleOptions,
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
    const response = await apiFetch(`/api/reports/${reportId}/generation-sessions?variant=${variant}`)
    const data = await response.json()
    if (!response.ok) throw new Error((data.error || 'Failed to load generation sessions') + traceSuffix(response))
    const rows = (data.sessions ?? []) as SessionSummary[]
    setSessions(rows)
    setActiveSessionId((current) => {
      if (preferredId && rows.some((item) => item.id === preferredId)) return preferredId
      if (current && rows.some((item) => item.id === current)) return current
      return rows[0]?.id ?? null
    })
  }, [reportId, variant])

  const loadDetail = useCallback(async (sessionId: number, settleLiveStream = false) => {
    const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${sessionId}`)
    const data = await response.json()
    if (!response.ok) throw new Error((data.error || 'Failed to load session') + traceSuffix(response))
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
        const response = await apiFetch(`/api/reports/${reportId}/generation-sessions?variant=${variant}`)
        const data = await response.json()
        if (!response.ok) throw new Error((data.error || 'Failed to load generation sessions') + traceSuffix(response))
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
        const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}`)
        const data = await response.json()
        if (!response.ok) throw new Error((data.error || 'Failed to load session') + traceSuffix(response))
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
      const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}))
        throw new Error((data.error || 'Failed to start AI generation') + traceSuffix(response))
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
      const response = await apiFetch(`/api/reports/${reportId}/generation-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, templateId, styleOverride: styleOverride || undefined }),
      })
      const session = await response.json()
      if (!response.ok) throw new Error((session.error || 'Failed to create generation session') + traceSuffix(response))
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
    const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}/turns/${turnId}/stop`, { method: 'POST' })
    if (!response.ok) toast.error('Failed to stop generation' + traceSuffix(response))
  }

  async function acceptProposal(proposal: ReviewableProposal) {
    if (!activeSessionId) return
    if (reportVariant.finalContent && !confirm('Accepting will replace the current final version. Continue?')) return
    setAccepting(true)
    try {
      const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}/proposals/${proposal.id}/accept`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error((data.error || 'Failed to save proposed final version') + traceSuffix(response))
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

  async function archiveSession() {
    if (!activeSessionId || !confirm('After archiving, the record remains viewable but cannot continue chatting. Archive this session?')) return
    const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}`, { method: 'DELETE' })
    const data = await response.json()
    if (!response.ok) return toast.error((data.error || 'Archive failed') + traceSuffix(response))
    await loadSessions(activeSessionId)
    await loadDetail(activeSessionId)
  }

  async function renameSession() {
    if (!activeSessionId || !detail) return
    const title = prompt('Session title', detail.title)
    if (!title || title.trim() === detail.title) return
    const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${activeSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const data = await response.json()
    if (!response.ok) return toast.error((data.error || 'Rename failed') + traceSuffix(response))
    await Promise.all([loadDetail(activeSessionId), loadSessions(activeSessionId)])
  }

  const proposal = liveProposal ?? detail?.proposals.at(-1) ?? null
  const lastTurn = detail?.turns.at(-1)
  const lastUserMessage = lastTurn ? detail?.messages.find((part) => part.turnId === lastTurn.id && part.role === 'user' && part.partType === 'text')?.content : null
  const noProposalAfterLastTurn = Boolean(lastTurn?.status === 'completed' && !detail?.proposals.some((item) => item.turnId === lastTurn.id))
  const canChat = editable && detail?.status === 'active' && detail.sourceIsCurrent

  if (loading) return <div className={styles.workspace}><div className={styles.transcriptLoading} role="status">Loading generation sessions...</div></div>

  return (
    <div className={styles.workspace}>
      <div className={styles.sessionBar}>
        <div className={styles.sessionSelectWrap}>
          <Sparkles size={16} aria-hidden="true" />
          <label htmlFor="generation-session-select" className={styles.srOnly}>Generation session</label>
          <select
            id="generation-session-select"
            className={styles.select}
            value={activeSessionId ?? ''}
            onChange={(event) => {
              const value = event.target.value
              setActiveSessionId(value ? Number(value) : null)
              if (!value) setDetail(null)
            }}
          >
            <option value="">New generation session</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.status === 'archived' ? '[Archived] ' : ''}{session.title}
              </option>
            ))}
          </select>
        </div>
        {editable && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => { setActiveSessionId(null); setDetail(null); setComposer(DEFAULT_GENERATION_INSTRUCTION) }}
          >
            <Plus size={16} aria-hidden="true" />
            New session
          </button>
        )}
      </div>

      {!activeSessionId ? (
        editable ? (
          <div className={styles.createPanel}>
            <div className={styles.createHeading}>
              <h2 className={styles.createTitle}>Create AI generation session</h2>
              <p className={styles.createCopy}>
                The current source draft, template, style, and system prompts are locked when you create the session,
                then the initial instruction below is sent.
              </p>
            </div>
            <div className={styles.createGrid}>
              <div className={styles.field}>
                <label htmlFor="generation-template" className={styles.fieldLabel}>Template</label>
                <select
                  id="generation-template"
                  className={styles.select}
                  value={templateId}
                  onChange={(event) => {
                    setTemplateId(event.target.value)
                    const selected = templates.find((item) => item.id === event.target.value)
                    setStyleOverride(selected?.aiStyle ?? '')
                  }}
                >
                  <option value="">Select a template</option>
                  {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="generation-style" className={styles.fieldLabel}>AI style</label>
                <select
                  id="generation-style"
                  className={styles.select}
                  value={styleOverride}
                  onChange={(event) => setStyleOverride(event.target.value)}
                >
                  <option value="">Use template default style</option>
                  {styleOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </div>
            </div>
            <div className={styles.field}>
              <label htmlFor="initial-generation-message" className={styles.fieldLabel}>Initial instruction (editable)</label>
              <Textarea
                id="initial-generation-message"
                className={styles.textarea}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
              />
            </div>
            <button
              type="button"
              className={`${styles.primaryButton} ${styles.fullWidth}`}
              onClick={() => void createSession()}
              disabled={creating || !templateId || !composer.trim()}
            >
              {creating
                ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />
                : <Send size={16} aria-hidden="true" />}
              Create session and send
            </button>
          </div>
        ) : (
          <div className={styles.emptyPanel}>This version has no AI generation sessions.</div>
        )
      ) : !detail ? (
        <div className={styles.workspace}><div className={styles.transcriptLoading}>Loading chat...</div></div>
      ) : (
        <div className={styles.sessionGrid}>
          <section className={styles.chatPanel}>
            <div className={styles.chatHeader}>
              <div className={styles.chatTitleWrap}>
                <div className={styles.chatTitleRow}>
                  <h2 className={styles.chatTitle}>{detail.title}</h2>
                  {detail.status === 'archived' && <span className={styles.archivedBadge}>Archived</span>}
                </div>
                <p className={styles.sessionMeta}>
                  {detail.templateName} · {detail.aiStyleLabel} · Source r{detail.sourceRevision}
                  {detail.turns.at(-1) ? ` · ${detail.turns.at(-1)?.protocol}/${detail.turns.at(-1)?.model}` : ''}
                </p>
              </div>
              {editable && (
                <div className={styles.headerActions}>
                  <button type="button" className={styles.iconButton} title="Rename" aria-label="Rename" onClick={() => void renameSession()}>
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                  {detail.status === 'active' && (
                    <button
                      type="button"
                      className={styles.iconButton}
                      title="Archive"
                      aria-label="Archive"
                      onClick={() => void archiveSession()}
                      disabled={streaming}
                    >
                      <Archive size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </div>
            {!detail.sourceIsCurrent && (
              <div className={styles.staleBanner} role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>The source draft has changed. This session is retained for audit; create a new session from the latest draft.</span>
              </div>
            )}
            <div
              ref={transcriptRef}
              onScroll={handleTranscriptScroll}
              className={`${styles.transcript} generation-transcript min-h-[520px] max-h-[calc(100vh-15rem)] overflow-y-auto`}
            >
              <SystemContextCard
                detail={detail}
                onRefresh={(snapshotId) => {
                  if (snapshotId) void (async () => {
                    const response = await apiFetch(`/api/reports/${reportId}/generation-sessions/${detail.id}/query-snapshots/refresh`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ snapshotId }),
                    })
                    if (!response.ok) {
                      toast.error('刷新历史查询失败' + traceSuffix(response))
                      return
                    }
                    await loadDetail(detail.id)
                  })()
                }}
              />
              {detail.messages.map((part) => (
                <TranscriptPart
                  key={part.id}
                  part={part}
                  onRetry={part.partType === 'tool-result'
                    ? () => {
                        const message = detail.messages.filter((item) => item.role === 'user').at(-1)?.content
                        if (message) void streamTurn(detail.id, message)
                      }
                    : undefined}
                />
              ))}
              {liveUser && (
                <TranscriptPart
                  part={{ id: -1, turnId: liveTurnId, sequence: Number.MAX_SAFE_INTEGER, role: 'user', partType: 'text', content: liveUser, data: null }}
                />
              )}
              <LiveAssistant
                reasoning={liveReasoning}
                text={liveText}
                toolState={liveToolState}
                working={streaming || Boolean(detail.activeTurn && !liveTurnId)}
              />
              {noProposalAfterLastTurn && !streaming && canChat && (
                <div className={styles.noProposalHint}>
                  No proposed final version was submitted this turn.{' '}
                  <button
                    type="button"
                    className={styles.inlineLink}
                    onClick={() => void sendMessage('Turn the current discussion into a complete proposed final version and submit it with propose_final_report.')}
                  >
                    Submit current version
                  </button>
                </div>
              )}
              {lastTurn?.status === 'failed' && !streaming && canChat && lastUserMessage && (
                <div className={styles.retryLine}>
                  Generation failed this turn.{' '}
                  <button type="button" className={styles.inlineLink} onClick={() => void sendMessage(lastUserMessage)}>
                    Retry turn
                  </button>
                </div>
              )}
            </div>
            {canChat && (
              <div className={styles.composer}>
                <Textarea
                  className={styles.textarea}
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  placeholder="Ask AI to revise, answer a question, or submit the current version..."
                  disabled={streaming}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendMessage()
                    }
                  }}
                />
                <div className={styles.composerFoot}>
                  <p className={styles.composerHint}>Enter to send, Shift+Enter for a new line</p>
                  {streaming ? (
                    <button type="button" className={styles.secondaryButton} onClick={() => void stopTurn()}>
                      <Square size={14} aria-hidden="true" />
                      Stop
                    </button>
                  ) : (
                    <button type="button" className={styles.primaryButton} onClick={() => void sendMessage()} disabled={!composer.trim()}>
                      <Send size={15} aria-hidden="true" />
                      Send
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
          <ProposalReviewPanel
            proposal={proposal}
            editable={editable && detail.sourceIsCurrent}
            accepting={accepting}
            onAccept={() => proposal && void acceptProposal(proposal)}
          />
        </div>
      )}
    </div>
  )
}
