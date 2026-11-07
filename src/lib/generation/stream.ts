import type { PublicGenerationSummary } from './public-summary'

/**
 * 生成会话流的事件/提案类型契约（cutover 后仅类型）。
 *
 * 运行时（NDJSON 流的生成、节流落库、stop/断连收尾）已由 Go 侧
 * internal/engine + internal/generation 接管（ADR-0027 / 蓝图 B6）；
 * web/（SPA）与既有 client 测试仍以这些类型描述引擎输出形状——
 * NDJSON 事件流与 publicSummary 结构在两侧必须逐字段对等，
 * Go 侧的结构校验测试与 e2e（scripted AI）共同守护该契约。
 */

export type GenerationStreamProposal = {
  id: number
  content: string
  summary: string[]
  status: string
  sourceRevision: number
  createdAt: Date
  publicSummary?: PublicGenerationSummary | null
  baselineContent?: string | null
}

/**
 * Shared renderable proposal type. Both the DB `Proposal` shape and the
 * wire proposal shape (from `GenerationStreamEvent`) satisfy this interface,
 * so proposal review panels and the live-proposal state can consume either
 * source.
 */
export type ReviewableProposal = {
  id: number
  content: string
  summary: string[]
  status: string
  sourceRevision: number
  createdAt: string | Date
  publicSummary?: PublicGenerationSummary | null
  baselineContent?: string | null
  referenceChanged?: boolean
}

export type GenerationStreamEvent =
  | { type: 'start'; turnId: number; protocol: string; model: string }
  | { type: 'working'; label: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-delta'; toolName: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string }
  | { type: 'tool-result'; toolName: string; toolCallId: string }
  | { type: 'proposal'; proposal: GenerationStreamProposal }
  | { type: 'finish'; status: 'completed' | 'aborted' }
  | { type: 'error'; message: string }
