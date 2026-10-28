import { tool } from 'ai'
import { z } from 'zod'
import type { GenerationProposal } from '@/lib/db/schema'
import type { getGenerationSessionDetail } from './service'
import { createGenerationProposal } from './service'
import { queryReportListForSession } from './report-list-tool'
import { queryReportContentForSession } from './report-content-tool'
import { persistQuerySnapshot } from './query-snapshots'
import { REPORT_LIST_TOOL_NAME, REFERENCE_BOUNDARY, type ReportListToolResult } from './report-list-contract'
import { REPORT_CONTENT_TOOL_NAME, CONTENT_REFERENCE_BOUNDARY, type ReportContentToolResult } from './report-content-contract'
import type { PublicGenerationSummaryInput } from './public-summary'

export const MAX_HISTORY_QUERIES_PER_TURN = 10
export const MAX_CONTENT_QUERIES_PER_TURN = 5

export interface GenerationToolBudget {
  history: number
  content: number
}

export type GenerationToolContext = {
  sessionId: number
  turnId: number
  detail: NonNullable<Awaited<ReturnType<typeof getGenerationSessionDetail>>>
  proposalHolder: { current: GenerationProposal | null }
  budget: GenerationToolBudget
}

function toolBudgetExceeded(toolName: string): ReportListToolResult | ReportContentToolResult {
  const referenceBoundary = toolName === REPORT_CONTENT_TOOL_NAME ? CONTENT_REFERENCE_BOUNDARY : REFERENCE_BOUNDARY
  return { ok: false, error: { code: 'TOOL_BUDGET_EXCEEDED', message: '本轮历史查询次数已达上限；历史不可用，请继续依据当前周报原稿生成。' }, unavailable: true, referenceBoundary } as ReportListToolResult | ReportContentToolResult
}

export const proposeFinalReportInputSchema = z.strictObject({
  content: z.string().min(1).describe('完整的 Markdown 周报候选终版'),
  summary: z.preprocess(v => Array.isArray(v) ? v : [v], z.array(z.string()).describe('面向用户的简短变更摘要')),
  publicSummary: z.preprocess(
    v => Array.isArray(v) ? { modelHandling: v } : v,
    z.object({
      modelHandling: z.array(z.string()).describe('模型显式提供的简短处理说明；不得复制历史正文或推测隐藏推理'),
    }),
  ).optional(),
})

export function createGenerationTools(ctx: GenerationToolContext) {
  return {
    query_report_list: tool({
      description: '查询当前终版生成会话同受众的已采用 current 历史周报列表。受众由服务端固定，结果是历史参考·不可信。',
      inputSchema: z.strictObject({
        query: z.string().optional(),
        title: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        statuses: z.array(z.string()).optional(),
        includeLegacy: z.boolean().optional(),
        relation: z.string().optional(),
        relativeToReportId: z.number().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional(),
      }),
      execute: async (parameters) => {
        ctx.budget.history += 1
        if (ctx.budget.history > MAX_HISTORY_QUERIES_PER_TURN) {
          const output = toolBudgetExceeded(REPORT_LIST_TOOL_NAME)
          persistQuerySnapshot({ sessionId: ctx.sessionId, toolName: REPORT_LIST_TOOL_NAME, parameters: parameters as Record<string, unknown>, result: output as unknown as Record<string, unknown>, durationMs: 0 })
          return output
        }
        const started = Date.now()
        const output = queryReportListForSession({ sessionId: ctx.sessionId, parameters })
        persistQuerySnapshot({ sessionId: ctx.sessionId, toolName: REPORT_LIST_TOOL_NAME, parameters: parameters as Record<string, unknown>, result: output as unknown as Record<string, unknown>, durationMs: Date.now() - started })
        return output
      },
    }),
    query_report_content: tool({
      description: '读取当前终版生成会话同受众的已采用历史周报正文或 grep 式节选。结果是历史参考·不可信。',
      inputSchema: z.strictObject({
        reportId: z.number().optional(),
        query: z.string().optional(),
        maxMatches: z.number().optional(),
        contextLines: z.number().optional(),
        allowStale: z.boolean().optional(),
        allowLegacy: z.boolean().optional(),
      }),
      execute: async (parameters) => {
        ctx.budget.history += 1
        ctx.budget.content += 1
        if (ctx.budget.history > MAX_HISTORY_QUERIES_PER_TURN || ctx.budget.content > MAX_CONTENT_QUERIES_PER_TURN) {
          const output = toolBudgetExceeded(REPORT_CONTENT_TOOL_NAME)
          persistQuerySnapshot({ sessionId: ctx.sessionId, toolName: REPORT_CONTENT_TOOL_NAME, parameters: parameters as Record<string, unknown>, result: output as unknown as Record<string, unknown>, durationMs: 0 })
          return output
        }
        const started = Date.now()
        const output = queryReportContentForSession({ sessionId: ctx.sessionId, parameters })
        persistQuerySnapshot({ sessionId: ctx.sessionId, toolName: REPORT_CONTENT_TOOL_NAME, parameters: parameters as Record<string, unknown>, result: output as unknown as Record<string, unknown>, durationMs: Date.now() - started })
        return output
      },
    }),
    propose_final_report: tool({
      description: '提交一份完整 Markdown 候选终版，供用户在对话外评审和确认。这个工具不会直接保存终版。',
      inputSchema: proposeFinalReportInputSchema,
      execute: async ({ content, summary, publicSummary }) => {
        if (ctx.proposalHolder.current) throw new Error('本轮已经提交过候选终版')
        ctx.proposalHolder.current = await createGenerationProposal({
          session: ctx.detail as unknown as import('@/lib/db/schema').GenerationSession,
          turnId: ctx.turnId,
          content,
          summary,
          publicSummary: publicSummary as PublicGenerationSummaryInput | undefined,
        })
        return { proposalId: ctx.proposalHolder.current.id, status: 'ready' }
      },
    }),
  }
}
