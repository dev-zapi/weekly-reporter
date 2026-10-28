import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  generationMessageParts,
  generationQuerySnapshots,
  generationProposals,
  generationSessions,
  generationTurns,
  reportVariants,
  reports,
  type AIConfig,
  type AudienceVariant,
  type GenerationMessagePartType,
  type GenerationMessageRole,
  type GenerationProposal,
  type GenerationSession,
} from '@/lib/db/schema'
import { getSystemPrompt } from '@/lib/ai'
import { getAIStyle } from '@/lib/ai/styles'
import { getTemplateSelection, getReportBundle } from '@/lib/reports/service'
import {
  buildEffectiveGenerationSystemPrompt,
  buildSourceOverview,
  FINAL_REPORT_TOOL_RULES,
} from './context'
import { isEmptySourceDraft } from '@/lib/reports/source-draft'
import {
  buildPublicGenerationSummary,
  normalizePublicGenerationSummary,
  type PublicGenerationSummaryInput,
} from './public-summary'
import { isReportListToolResult, REPORT_LIST_TOOL_NAME } from './report-list-contract'
import { isReportContentToolResult, REPORT_CONTENT_TOOL_NAME } from './report-content-contract'
import { listQuerySnapshots } from './query-snapshots'
import { persistQuerySnapshot } from './query-snapshots'
import { queryReportListForSession } from './report-list-tool'
import { queryReportContentForSession } from './report-content-tool'

const MAX_PROPOSAL_CHARACTERS = 200_000

function proposalReferenceChanged(proposal: GenerationProposal, snapshots: ReturnType<typeof listQuerySnapshots>): boolean {
  return proposal.status === 'pending' && snapshots.some((snapshot) => snapshot.trigger === 'user' && snapshot.createdAt > proposal.createdAt)
}

export class GenerationServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'GenerationServiceError'
  }
}

export function error(message: string, code: string, status: number): never {
  throw new GenerationServiceError(message, code, status)
}

function nextSequence(sessionId: number): number {
  const db = getDb()
  const row = db.select({ value: sql<number>`coalesce(max(${generationMessageParts.sequence}), 0)` })
    .from(generationMessageParts)
    .where(eq(generationMessageParts.sessionId, sessionId))
    .get()
  return Number(row?.value ?? 0) + 1
}

export function appendGenerationPart(input: {
  sessionId: number
  turnId?: number | null
  role: GenerationMessageRole
  partType: GenerationMessagePartType
  content?: string | null
  data?: Record<string, unknown> | null
}) {
  const db = getDb()
  return db.insert(generationMessageParts).values({
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    sequence: nextSequence(input.sessionId),
    role: input.role,
    partType: input.partType,
    content: input.content ?? null,
    data: input.data ?? null,
    createdAt: new Date(),
  }).returning().get()
}

export function updateGenerationPart(id: number, content: string) {
  return getDb().update(generationMessageParts)
    .set({ content })
    .where(eq(generationMessageParts.id, id))
    .returning()
    .get()
}

export async function createGenerationSession(input: {
  reportId: number
  variant: AudienceVariant
  templateId: string
  styleOverride?: string
}): Promise<GenerationSession> {
  const [bundle, template, basePrompt] = await Promise.all([
    getReportBundle(input.reportId),
    getTemplateSelection(input.templateId),
    getSystemPrompt('generate'),
  ])
  if (!bundle) error('Report not found', 'REPORT_NOT_FOUND', 404)
  if (!template) error('Template not found', 'TEMPLATE_NOT_FOUND', 404)

  const reportVariant = bundle.variants.find((item) => item.variant === input.variant)
  if (!reportVariant) error('Report variant not found', 'VARIANT_NOT_FOUND', 404)
  if (reportVariant.sourceRevision === 0 || isEmptySourceDraft(reportVariant.sourceDraft)) {
    error('No events are available to generate the final report', 'EMPTY_SOURCE_DRAFT', 400)
  }

  const styleKey = input.styleOverride || template.aiStyle || 'formal'
  const style = await getAIStyle(styleKey)
  const now = new Date()
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const db = getDb()

  return db.transaction((tx) => {
    const session = tx.insert(generationSessions).values({
      reportId: input.reportId,
      reportVariantId: reportVariant.id,
      variant: input.variant,
      title: `${template.name} · ${timeLabel}`,
      status: 'active',
      sourceRevision: reportVariant.sourceRevision,
      sourceDraftSnapshot: reportVariant.sourceDraft,
      sourceOverview: buildSourceOverview(reportVariant.sourceDraft, input.variant),
      templateId: template.id,
      templateName: template.name,
      templateContent: template.content,
      aiStyleKey: styleKey,
      aiStyleLabel: style.label,
      aiStylePrompt: style.systemPrompt,
      temperature: String(style.temperature),
      systemPrompt: buildEffectiveGenerationSystemPrompt(basePrompt),
      toolRules: FINAL_REPORT_TOOL_RULES,
      baselineFinalContent: reportVariant.finalContent,
      createdAt: now,
      updatedAt: now,
    }).returning().get()

    tx.insert(generationMessageParts).values([
      { sessionId: session.id, turnId: null, sequence: 1, role: 'system', partType: 'system-prompt', content: session.systemPrompt, createdAt: now },
      { sessionId: session.id, turnId: null, sequence: 2, role: 'system', partType: 'style-prompt', content: session.aiStylePrompt, data: { key: session.aiStyleKey, label: session.aiStyleLabel }, createdAt: now },
      { sessionId: session.id, turnId: null, sequence: 3, role: 'system', partType: 'tool-rules', content: session.toolRules, createdAt: now },
      { sessionId: session.id, turnId: null, sequence: 4, role: 'system', partType: 'source-overview', content: session.sourceOverview, createdAt: now },
    ]).run()

    return session
  })
}

export async function listGenerationSessions(reportId: number, variant?: AudienceVariant) {
  const db = getDb()
  const rows = await db.select().from(generationSessions)
    .where(variant
      ? and(eq(generationSessions.reportId, reportId), eq(generationSessions.variant, variant))
      : eq(generationSessions.reportId, reportId))
    .orderBy(desc(generationSessions.updatedAt))

  return Promise.all(rows.map(async (session) => {
    const [latestTurn, latestProposal] = await Promise.all([
      db.select().from(generationTurns).where(eq(generationTurns.sessionId, session.id)).orderBy(desc(generationTurns.id)).limit(1),
      db.select().from(generationProposals).where(eq(generationProposals.sessionId, session.id)).orderBy(desc(generationProposals.id)).limit(1),
    ])
    return {
      ...session,
      latestTurn: latestTurn[0] ?? null,
      latestProposal: latestProposal[0] ? {
        ...latestProposal[0],
        publicSummary: normalizePublicGenerationSummary(latestProposal[0].publicSummary),
      } : null,
    }
  }))
}

export async function getGenerationSessionDetail(reportId: number, sessionId: number) {
  const db = getDb()
  const session = await db.query.generationSessions.findFirst({
    where: and(eq(generationSessions.id, sessionId), eq(generationSessions.reportId, reportId)),
  })
  if (!session) return null

  const [messages, turns, proposals, currentVariant] = await Promise.all([
    db.select().from(generationMessageParts).where(eq(generationMessageParts.sessionId, sessionId)).orderBy(asc(generationMessageParts.sequence)),
    db.select().from(generationTurns).where(eq(generationTurns.sessionId, sessionId)).orderBy(asc(generationTurns.id)),
    db.select().from(generationProposals).where(eq(generationProposals.sessionId, sessionId)).orderBy(asc(generationProposals.id)),
    db.query.reportVariants.findFirst({ where: eq(reportVariants.id, session.reportVariantId) }),
  ])

  const querySnapshots = listQuerySnapshots(sessionId)

  return {
    ...session,
    messages,
    turns,
    proposals: proposals.map((proposal) => ({
      ...proposal,
      publicSummary: normalizePublicGenerationSummary(proposal.publicSummary),
      referenceChanged: proposalReferenceChanged(proposal, querySnapshots),
    })),
    querySnapshots,
    historicalReferencesChanged: proposals.some((proposal) => proposalReferenceChanged(proposal, querySnapshots)),
    sourceIsCurrent: currentVariant?.sourceRevision === session.sourceRevision,
    activeTurn: turns.find((turn) => turn.status === 'working') ?? null,
  }
}

export async function refreshHistoricalQuery(input: { reportId: number; sessionId: number; snapshotId?: number }) {
  const db = getDb()
  const session = db.select().from(generationSessions).where(and(eq(generationSessions.id, input.sessionId), eq(generationSessions.reportId, input.reportId))).get()
  if (!session) error('Generation session not found', 'SESSION_NOT_FOUND', 404)
  const previous = db.select().from(generationQuerySnapshots).where(and(eq(generationQuerySnapshots.id, input.snapshotId ?? 0), eq(generationQuerySnapshots.sessionId, input.sessionId))).get()
  if (!previous) error('Query snapshot not found', 'SNAPSHOT_NOT_FOUND', 404)
  const started = Date.now()
  if (previous.toolName !== REPORT_LIST_TOOL_NAME && previous.toolName !== REPORT_CONTENT_TOOL_NAME) {
    error('Unsupported historical query tool', 'SNAPSHOT_INVALID', 400)
  }
  const result = previous.toolName === REPORT_LIST_TOOL_NAME
    ? queryReportListForSession({ sessionId: input.sessionId, parameters: previous.parameters as never })
    : queryReportContentForSession({ sessionId: input.sessionId, parameters: previous.parameters as never })
  const snapshot = persistQuerySnapshot({ sessionId: input.sessionId, toolName: previous.toolName, parameters: previous.parameters, result: result as unknown as Record<string, unknown>, durationMs: Date.now() - started, trigger: 'user', previousSnapshotId: previous.id })
  if (snapshot) {
    appendGenerationPart({
      sessionId: input.sessionId,
      role: 'tool',
      partType: 'tool-result',
      content: `历史查询已刷新：${previous.toolName}。历史参考·不可信。`,
      data: { toolName: previous.toolName, output: result, snapshotId: snapshot.id, refreshed: true },
    })
  }
  return snapshot
}

export async function renameGenerationSession(reportId: number, sessionId: number, title: string) {
  const trimmed = title.trim()
  if (!trimmed) error('Session title is required', 'INVALID_TITLE', 400)
  const updated = await getDb().update(generationSessions).set({
    title: trimmed.slice(0, 120),
    updatedAt: new Date(),
  }).where(and(eq(generationSessions.id, sessionId), eq(generationSessions.reportId, reportId))).returning()
  if (!updated[0]) error('Generation session not found', 'SESSION_NOT_FOUND', 404)
  return updated[0]
}

export async function archiveGenerationSession(reportId: number, sessionId: number) {
  const db = getDb()
  const working = await db.query.generationTurns.findFirst({
    where: and(eq(generationTurns.sessionId, sessionId), eq(generationTurns.status, 'working')),
  })
  if (working) error('AI is still generating; stop the current turn first', 'TURN_IN_PROGRESS', 409)
  const now = new Date()
  const updated = await db.update(generationSessions).set({ status: 'archived', archivedAt: now, updatedAt: now })
    .where(and(eq(generationSessions.id, sessionId), eq(generationSessions.reportId, reportId))).returning()
  if (!updated[0]) error('Generation session not found', 'SESSION_NOT_FOUND', 404)
  return updated[0]
}

export function startGenerationTurn(input: {
  session: GenerationSession
  config: AIConfig
  userMessage: string
}) {
  const userMessage = input.userMessage.trim()
  if (!userMessage) error('Message is required', 'EMPTY_MESSAGE', 400)
  if (input.session.status !== 'active') error('Session is archived', 'SESSION_ARCHIVED', 409)

  const db = getDb()
  const now = new Date()
  return db.transaction((tx) => {
    const currentVariant = tx.select().from(reportVariants).where(eq(reportVariants.id, input.session.reportVariantId)).get()
    if (!currentVariant || currentVariant.sourceRevision !== input.session.sourceRevision) {
      error('The source draft has changed; start a new session', 'SOURCE_REVISION_CONFLICT', 409)
    }
    const active = tx.select().from(generationTurns).where(
      and(eq(generationTurns.sessionId, input.session.id), eq(generationTurns.status, 'working')),
    ).get()
    if (active) error('This session already has a turn in progress', 'TURN_IN_PROGRESS', 409)

    const turn = tx.insert(generationTurns).values({
      sessionId: input.session.id,
      status: 'working',
      protocol: input.config.protocol,
      model: input.config.model,
      reasoningEffort: null,
      createdAt: now,
    }).returning().get()
    const sequence = tx.select({ value: sql<number>`coalesce(max(${generationMessageParts.sequence}), 0)` })
      .from(generationMessageParts).where(eq(generationMessageParts.sessionId, input.session.id)).get()
    const next = Number(sequence?.value ?? 0) + 1
    tx.insert(generationMessageParts).values([
      { sessionId: input.session.id, turnId: turn.id, sequence: next, role: 'user', partType: 'text', content: userMessage, createdAt: now },
      { sessionId: input.session.id, turnId: turn.id, sequence: next + 1, role: 'application', partType: 'status', content: 'Working...', data: { status: 'working' }, createdAt: now },
    ]).run()
    tx.update(generationSessions).set({ updatedAt: now }).where(eq(generationSessions.id, input.session.id)).run()
    return turn
  })
}

export async function finishGenerationTurn(turnId: number, status: 'completed' | 'failed' | 'aborted', errorMessage?: string) {
  const db = getDb()
  const turn = await db.query.generationTurns.findFirst({ where: eq(generationTurns.id, turnId) })
  if (!turn) return null
  const now = new Date()
  const updated = await db.update(generationTurns).set({
    status,
    error: errorMessage ?? null,
    finishedAt: now,
  }).where(eq(generationTurns.id, turnId)).returning()
  await db.update(generationSessions).set({ updatedAt: now }).where(eq(generationSessions.id, turn.sessionId))
  const statusPart = await db.query.generationMessageParts.findFirst({
    where: and(
      eq(generationMessageParts.turnId, turnId),
      eq(generationMessageParts.partType, 'status'),
    ),
  })
  if (statusPart) {
    await db.update(generationMessageParts).set({
      content: status === 'completed' ? 'Completed' : status === 'aborted' ? 'Stopped' : 'Generation failed',
      data: { status },
    }).where(eq(generationMessageParts.id, statusPart.id))
  }
  if (errorMessage) {
    appendGenerationPart({ sessionId: turn.sessionId, turnId, role: 'application', partType: 'error', content: errorMessage })
  }
  return updated[0] ?? null
}

export async function createGenerationProposal(input: {
  session: GenerationSession
  turnId: number
  content: string
  summary: string[]
  publicSummary?: PublicGenerationSummaryInput
}): Promise<GenerationProposal> {
  const content = input.content.trim()
  const summary = input.summary.map((item) => item.trim()).filter(Boolean)
  if (!content) error('Proposal content is required', 'EMPTY_PROPOSAL', 400)
  if (content.length > MAX_PROPOSAL_CHARACTERS) error('Proposal content is too long', 'PROPOSAL_TOO_LARGE', 400)

  const db = getDb()
  return db.transaction((tx) => {
    const storedSession = tx.select().from(generationSessions).where(eq(generationSessions.id, input.session.id)).get()
    if (!storedSession) error('Generation session not found', 'SESSION_NOT_FOUND', 404)
    const currentVariant = tx.select().from(reportVariants).where(eq(reportVariants.id, storedSession.reportVariantId)).get()
    if (!currentVariant || currentVariant.sourceRevision !== storedSession.sourceRevision) {
      error('The source draft changed; this proposal is based on an older version', 'SOURCE_REVISION_CONFLICT', 409)
    }
    const turn = tx.select().from(generationTurns).where(eq(generationTurns.id, input.turnId)).get()
    if (!turn || turn.sessionId !== storedSession.id || turn.status !== 'working') {
      error('The current generation turn has ended', 'TURN_NOT_ACTIVE', 409)
    }
    const existingForTurn = tx.select().from(generationProposals).where(eq(generationProposals.turnId, input.turnId)).get()
    if (existingForTurn) error('Only one proposal may be submitted per turn', 'PROPOSAL_LIMIT', 409)

    const effectiveSummary = summary.slice(0, 8)
    const toolResults = tx.select({ data: generationMessageParts.data }).from(generationMessageParts).where(
      and(eq(generationMessageParts.sessionId, storedSession.id), eq(generationMessageParts.partType, 'tool-result')),
    ).all()
    const historicalReportListResults = toolResults.flatMap(({ data }) => data?.toolName === REPORT_LIST_TOOL_NAME && isReportListToolResult(data.output) ? [data.output] : [])
    const historicalReportContentResults = toolResults.flatMap(({ data }) => data?.toolName === REPORT_CONTENT_TOOL_NAME && isReportContentToolResult(data.output) ? [data.output] : [])
    const publicSummary = buildPublicGenerationSummary({
      explicit: input.publicSummary,
      changeSummary: summary,
      historicalReportListResults,
      historicalReportContentResults,
    })
    tx.update(generationProposals).set({ status: 'superseded' })
      .where(and(eq(generationProposals.sessionId, storedSession.id), eq(generationProposals.status, 'pending'))).run()
    return tx.insert(generationProposals).values({
      sessionId: storedSession.id,
      turnId: input.turnId,
      content,
      summary: effectiveSummary,
      sourceRevision: storedSession.sourceRevision,
      status: 'pending',
      publicSummary: publicSummary as unknown as Record<string, unknown>,
      baselineContent: storedSession.baselineFinalContent ?? '',
      createdAt: new Date(),
    }).returning().get()
  })
}

export async function getLatestGenerationProposal(sessionId: number) {
  const rows = await getDb().select().from(generationProposals)
    .where(eq(generationProposals.sessionId, sessionId))
    .orderBy(desc(generationProposals.id)).limit(1)
  return rows[0] ?? null
}

export async function acceptGenerationProposal(input: {
  reportId: number
  sessionId: number
  proposalId: number
}) {
  const db = getDb()
  const now = new Date()
  const accepted = db.transaction((tx) => {
    const session = tx.select().from(generationSessions).where(
      and(eq(generationSessions.id, input.sessionId), eq(generationSessions.reportId, input.reportId)),
    ).get()
    if (!session) error('Generation session not found', 'SESSION_NOT_FOUND', 404)
    const proposal = tx.select().from(generationProposals).where(
      and(eq(generationProposals.id, input.proposalId), eq(generationProposals.sessionId, input.sessionId)),
    ).get()
    if (!proposal) error('Proposal not found', 'PROPOSAL_NOT_FOUND', 404)
    if (proposal.status === 'superseded') error('This proposal has been superseded', 'PROPOSAL_SUPERSEDED', 409)
    const currentVariant = tx.select().from(reportVariants).where(eq(reportVariants.id, session.reportVariantId)).get()
    if (!currentVariant || currentVariant.sourceRevision !== session.sourceRevision || proposal.sourceRevision !== session.sourceRevision) {
      error('The source draft changed; start a new session from the latest draft', 'SOURCE_REVISION_CONFLICT', 409)
    }

    const updatedVariant = tx.update(reportVariants).set({
      finalContent: proposal.content,
      finalStatus: 'current',
      templateId: session.templateId,
      templateName: session.templateName,
      templateContent: session.templateContent,
      aiStyle: session.aiStyleKey,
      acceptedProposalId: proposal.id,
      updatedAt: now,
    }).where(eq(reportVariants.id, currentVariant.id)).returning().get()
    tx.update(generationProposals).set({ status: 'accepted', acceptedAt: now }).where(eq(generationProposals.id, proposal.id)).run()
    if (session.variant === 'personal') {
      tx.update(reports).set({ content: proposal.content, updatedAt: now }).where(eq(reports.id, input.reportId)).run()
    }
    tx.update(generationSessions).set({ baselineFinalContent: proposal.content, updatedAt: now }).where(eq(generationSessions.id, session.id)).run()
    const sequence = tx.select({ value: sql<number>`coalesce(max(${generationMessageParts.sequence}), 0)` })
      .from(generationMessageParts).where(eq(generationMessageParts.sessionId, session.id)).get()
    tx.insert(generationMessageParts).values({
      sessionId: session.id,
      turnId: null,
      sequence: Number(sequence?.value ?? 0) + 1,
      role: 'application',
      partType: 'proposal-accepted',
      content: '用户已确认并保存该候选终版。',
      data: { proposalId: proposal.id },
      createdAt: now,
    }).run()
    return { session, proposal: { ...proposal, status: 'accepted' as const, acceptedAt: now }, variant: updatedVariant }
  })

  return accepted
}
