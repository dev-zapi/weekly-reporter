import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { StructureCompletenessRule } from '@/lib/reports/structure-completeness'

export type AudienceVariant = 'leadership' | 'personal'
export type FinalStatus = 'none' | 'current' | 'stale'
export type GenerationSessionStatus = 'active' | 'archived'
export type GenerationTurnStatus = 'working' | 'completed' | 'failed' | 'aborted'
export type GenerationMessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'application'
export type GenerationMessagePartType =
  | 'system-prompt'
  | 'style-prompt'
  | 'tool-rules'
  | 'source-overview'
  | 'text'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'status'
  | 'error'
  | 'proposal-accepted'
export type GenerationProposalStatus = 'pending' | 'accepted' | 'superseded'
export type PlanJudgment = 'carry' | 'drop' | 'uncertain'
export type PlanOverrideAction = 'keep' | 'drop' | 'rewrite' | 're-add'
export type PlanOverrideSource = 'carry-forward' | 'this-week-new' | 'baseline'

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  weekStart: text('week_start').notNull(),
  weekEnd: text('week_end').notNull(),
  aiStyleOverride: text('ai_style_override').$type<AIStyle>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type Report = typeof reports.$inferSelect
export type NewReport = typeof reports.$inferInsert

/**
 * A persisted audience-specific source draft and optional AI-generated final.
 */
export const reportVariants = sqliteTable('report_variants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reportId: integer('report_id').notNull(),
  variant: text('variant').notNull().$type<AudienceVariant>(),
  sourceDraft: text('source_draft').notNull(),
  finalContent: text('final_content'),
  finalStatus: text('final_status').notNull().default('none').$type<FinalStatus>(),
  templateId: text('template_id'),
  templateName: text('template_name'),
  templateContent: text('template_content'),
  /** Immutable structure-completeness contract captured when this final is adopted. */
  structureCompletenessRule: text('structure_completeness_rule', { mode: 'json' }).$type<StructureCompletenessRule>(),
  aiStyle: text('ai_style').$type<AIStyle>(),
  acceptedProposalId: integer('accepted_proposal_id'),
  sourceRevision: integer('source_revision').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  reportVariantUnique: uniqueIndex('report_variants_report_variant_unique').on(table.reportId, table.variant),
}))

export type ReportVariant = typeof reportVariants.$inferSelect
export type NewReportVariant = typeof reportVariants.$inferInsert

/** Immutable event facts captured when a report's source drafts are created. */
export const reportEventSnapshots = sqliteTable('report_event_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reportId: integer('report_id').notNull(),
  rawEventId: integer('raw_event_id'),
  eventTime: integer('event_time', { mode: 'timestamp' }).notNull(),
  source: text('source').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<RawEventMetadata>(),
  projectScope: text('project_scope').$type<ProjectScope>(),
  leadershipIncluded: integer('leadership_included', { mode: 'boolean' }).notNull().default(false),
  personalIncluded: integer('personal_included', { mode: 'boolean' }).notNull().default(true),
  sourceRevision: integer('source_revision').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export type ReportEventSnapshot = typeof reportEventSnapshots.$inferSelect
export type NewReportEventSnapshot = typeof reportEventSnapshots.$inferInsert

/**
 * A durable, audience-specific AI conversation. Context that can change is
 * snapshotted so reopening a session never silently changes what the model saw.
 */
export const generationSessions = sqliteTable('generation_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reportId: integer('report_id').notNull(),
  reportVariantId: integer('report_variant_id').notNull(),
  variant: text('variant').notNull().$type<AudienceVariant>(),
  title: text('title').notNull(),
  status: text('status').notNull().default('active').$type<GenerationSessionStatus>(),
  sourceRevision: integer('source_revision').notNull(),
  sourceDraftSnapshot: text('source_draft_snapshot').notNull(),
  sourceOverview: text('source_overview').notNull(),
  templateId: text('template_id').notNull(),
  templateName: text('template_name').notNull(),
  templateContent: text('template_content').notNull(),
  aiStyleKey: text('ai_style_key').notNull(),
  aiStyleLabel: text('ai_style_label').notNull(),
  aiStylePrompt: text('ai_style_prompt').notNull(),
  temperature: text('temperature').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  toolRules: text('tool_rules').notNull(),
  planPolicy: text('plan_policy').$type<'forbidden' | 'required'>(),
  baselineFinalContent: text('baseline_final_content'),
  /** JSON snapshot of the exact previous-cycle plan reference, nullable for legacy sessions. */
  carryForwardSnapshot: text('carry_forward_snapshot'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
})

export type GenerationSession = typeof generationSessions.$inferSelect
export type NewGenerationSession = typeof generationSessions.$inferInsert

/** One user request and the streamed assistant response it produced. */
export const generationTurns = sqliteTable('generation_turns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  status: text('status').notNull().default('working').$type<GenerationTurnStatus>(),
  protocol: text('protocol').notNull().$type<AIProtocol>(),
  model: text('model').notNull(),
  reasoningEffort: text('reasoning_effort'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
})

export type GenerationTurn = typeof generationTurns.$inferSelect
export type NewGenerationTurn = typeof generationTurns.$inferInsert

/** Append-only, displayable transcript parts. Streamed text is coalesced. */
export const generationMessageParts = sqliteTable('generation_message_parts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  turnId: integer('turn_id'),
  sequence: integer('sequence').notNull(),
  role: text('role').notNull().$type<GenerationMessageRole>(),
  partType: text('part_type').notNull().$type<GenerationMessagePartType>(),
  content: text('content'),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  sessionSequenceUnique: uniqueIndex('generation_message_parts_session_sequence_unique').on(table.sessionId, table.sequence),
}))

export type GenerationMessagePart = typeof generationMessageParts.$inferSelect
export type NewGenerationMessagePart = typeof generationMessageParts.$inferInsert

/** A complete Markdown candidate emitted only through propose_final_report. */
export const generationProposals = sqliteTable('generation_proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  turnId: integer('turn_id').notNull(),
  content: text('content').notNull(),
  summary: text('summary', { mode: 'json' }).notNull().$type<string[]>(),
  sourceRevision: integer('source_revision').notNull(),
  status: text('status').notNull().default('pending').$type<GenerationProposalStatus>(),
  planState: text('plan_state', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Structured public audit summary; null only for proposals created before issue #23. */
  publicSummary: text('public_summary', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Editing baseline at proposal creation; null only when unavailable for legacy proposals. */
  baselineContent: text('baseline_content'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
})

export type GenerationProposal = typeof generationProposals.$inferSelect
export type NewGenerationProposal = typeof generationProposals.$inferInsert

/** First-session-only, publicly explained judgments for carry-forward candidates. */
export const generationPlanJudgments = sqliteTable('generation_plan_judgments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  candidateId: text('candidate_id').notNull(),
  judgment: text('judgment').notNull().$type<PlanJudgment>(),
  reason: text('reason').notNull(),
  remainingAction: text('remaining_action'),
  turnId: integer('turn_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  sessionCandidateUnique: uniqueIndex('generation_plan_judgments_session_candidate_unique').on(table.sessionId, table.candidateId),
}))

export type GenerationPlanJudgment = typeof generationPlanJudgments.$inferSelect
export type NewGenerationPlanJudgment = typeof generationPlanJudgments.$inferInsert

/** User-authored, append-only plan decisions scoped to one generation session. */
export const generationPlanOverrides = sqliteTable('generation_plan_overrides', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  itemId: text('item_id').notNull(),
  action: text('action').notNull().$type<PlanOverrideAction>(),
  replacementText: text('replacement_text'),
  source: text('source').notNull().$type<PlanOverrideSource>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  sessionIndex: index('generation_plan_overrides_session_idx').on(table.sessionId, table.id),
}))

export type GenerationPlanOverride = typeof generationPlanOverrides.$inferSelect
export type NewGenerationPlanOverride = typeof generationPlanOverrides.$inferInsert

export type HistoricalQueryTrigger = 'automatic' | 'user'
export const generationQuerySnapshots = sqliteTable('generation_query_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  toolName: text('tool_name').notNull(),
  parameters: text('parameters', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  calledAt: integer('called_at', { mode: 'timestamp' }).notNull(),
  sourceReportId: integer('source_report_id').notNull(),
  sourceAudience: text('source_audience').notNull().$type<AudienceVariant>(),
  sourceUpdatedAt: integer('source_updated_at', { mode: 'timestamp' }),
  sourceWeekStart: text('source_week_start'),
  sourceWeekEnd: text('source_week_end'),
  sourceFinalStatus: text('source_final_status'),
  result: text('result', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  resultCount: integer('result_count').notNull().default(0),
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  durationMs: integer('duration_ms').notNull().default(0),
  errorCode: text('error_code'),
  trigger: text('trigger').notNull().$type<HistoricalQueryTrigger>(),
  previousSnapshotId: integer('previous_snapshot_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
export type GenerationQuerySnapshot = typeof generationQuerySnapshots.$inferSelect

/** @deprecated 改用 string，风格现在是数据库实体，不再硬编码 key */
export type AIStyle = string

export const templates = sqliteTable('templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  content: text('content').notNull(),
  description: text('description'),
  tags: text('tags'),
  sourceTemplateId: text('source_template_id'),
  aiStyle: text('ai_style').default('formal').notNull().$type<AIStyle>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type Template = typeof templates.$inferSelect
export type NewTemplate = typeof templates.$inferInsert

export interface CollectSourceConfig {
  baseUrl?: string
  owner: string
  repo?: string
  token?: string
  authorEmails: string[]
  branches?: Array<string | { name: string; lastCommitTime?: string | null }>
  aliases?: string[]
}

export type CollectSourceStatus = 'enabled' | 'disabled' | 'unavailable'
export type ProjectScope = 'work' | 'personal'

export const collectSources = sqliteTable('collect_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).notNull().$type<CollectSourceConfig>(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
  status: text('status').$type<CollectSourceStatus>().default('enabled'),
  projectScope: text('project_scope').notNull().default('personal').$type<ProjectScope>(),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  lastSyncStatus: text('last_sync_status'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type CollectSource = typeof collectSources.$inferSelect
export type NewCollectSource = typeof collectSources.$inferInsert

export interface RawEventMetadata {
  sha?: string
  url?: string
  repo?: string
  branch?: string
  sourceId?: number
  sourceName?: string
  aliases?: string[]
}

export const rawEvents = sqliteTable('raw_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventTime: integer('event_time', { mode: 'timestamp' }).notNull(),
  source: text('source').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<RawEventMetadata>(),
  category: text('category'),
  isImportant: integer('is_important', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type RawEvent = typeof rawEvents.$inferSelect
export type NewRawEvent = typeof rawEvents.$inferInsert

export const eventTags = sqliteTable('event_tags', {
  eventId: integer('event_id').notNull(),
  tagName: text('tag_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  eventTagUnique: uniqueIndex('event_tags_event_tag_unique').on(t.eventId, t.tagName),
  tagNameIdx: index('event_tags_tag_name_idx').on(t.tagName),
}))

export type EventTag = typeof eventTags.$inferSelect
export type NewEventTag = typeof eventTags.$inferInsert

export const eventReferences = sqliteTable('event_references', {
  eventId: integer('event_id').notNull(),
  referencedEventId: integer('referenced_event_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  eventReferenceUnique: uniqueIndex('event_references_event_ref_unique').on(t.eventId, t.referencedEventId),
  referencedEventIdx: index('event_references_referenced_event_idx').on(t.referencedEventId),
}))

export type EventReference = typeof eventReferences.$inferSelect
export type NewEventReference = typeof eventReferences.$inferInsert

export const sentenceSnippets = sqliteTable('sentence_snippets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  content: text('content').notNull(),
  category: text('category').notNull().default('通用'),
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type SentenceSnippet = typeof sentenceSnippets.$inferSelect
export type NewSentenceSnippet = typeof sentenceSnippets.$inferInsert

export type AIProtocol = 'openai' | 'openai-compatible' | 'anthropic'

export const aiConfig = sqliteTable('ai_config', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  protocol: text('protocol').notNull().default('openai-compatible').$type<AIProtocol>(),
  apiUrl: text('api_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model').notNull(),
  modelListCache: text('model_list_cache', { mode: 'json' }).$type<string[]>(),
  modelListCachedAt: integer('model_list_cached_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type AIConfig = typeof aiConfig.$inferSelect
export type NewAIConfig = typeof aiConfig.$inferInsert

// --- AI 风格表（CRUD） ---

export type DetailLevel = 'low' | 'medium' | 'high'
export type ResultOriented = 'low' | 'medium' | 'high'

export interface ScoreWeights {
  structure: number
  content: number
  value: number
}

export const aiStyles = sqliteTable('ai_styles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  label: text('label').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  temperature: text('temperature').notNull().default('0.3'),
  detailLevel: text('detail_level').$type<DetailLevel>(),
  resultOriented: text('result_oriented').$type<ResultOriented>(),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type AIStyleRow = typeof aiStyles.$inferSelect
export type NewAIStyleRow = typeof aiStyles.$inferInsert

// --- 系统提示词表（全局唯一，只可编辑） ---

export type SystemPromptKey = 'check' | 'generate'

export const systemPrompts = sqliteTable('system_prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique().$type<SystemPromptKey>(),
  label: text('label').notNull(),
  promptText: text('prompt_text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type SystemPromptRow = typeof systemPrompts.$inferSelect
export type NewSystemPromptRow = typeof systemPrompts.$inferInsert
