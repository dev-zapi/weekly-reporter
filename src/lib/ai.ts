import { generateObject } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { systemPrompts } from '@/lib/db/schema'
import { getAIConfig } from './ai/config'
import { createModelFromConfig, AIConfigError } from './ai/provider'

/** 获取系统提示词模板 */
export async function getSystemPrompt(key: 'check' | 'generate'): Promise<string> {
  const db = getDb()
  const row = await db.query.systemPrompts.findFirst({
    where: eq(systemPrompts.key, key),
  })
  if (row) return row.promptText

  // 兜底：返回硬编码默认值
  if (key === 'check') {
    return `你是一个周报写作助手。用户正在写周报，请分析以下内容并给出改进建议。

内容：
{{content}}

{{#section}}当前区块：{{section}}{{/section}}

请从以下方面分析：
1. 是否有具体数据和细节支撑
2. 是否突出了成果和价值
3. 表达是否清晰简洁
4. 是否有更好的表达方式

请给出具体、简洁的建议（每条不超过20字）。
如果内容很好，返回空数组 []。`
  }
  if (key === 'generate') {
    return `你是周报终版生成助手。请严格依据原稿中的事实，按照模板要求输出 Markdown 周报。

规则：
- 只处理当前受众版本提供的原稿，不得引入其他版本的信息。
- 可以重组、合并、概括和补全表达，但不得虚构项目、数字、结果、时间或计划。
- 模板是格式规范，不要输出模板占位符、解释文字或代码围栏。
- 原稿没有事实支撑的章节请省略，或明确写出暂无内容。
- 只返回终版 Markdown 正文。`
  }

  throw new Error(`Unknown system prompt key: ${key}`)
}

/** 简单的 Mustache 风格模板替换：{{var}} 或 {{#var}}...{{/var}} */
function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  let result = template
  // 先处理条件块 {{#var}}...{{/var}}
  result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, content) => {
    return vars[key] ? content : ''
  })
  // 再处理简单变量 {{var}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return vars[key] ?? `{{${key}}}`
  })
  return result
}

export interface CheckRequest {
  content: string
  section?: string
}

export interface CheckResponse {
  suggestions: string[]
  score?: number
}

async function getModel() {
  const db = getDb()
  const config = await getAIConfig(db)
  if (!config) {
    throw new AIConfigError('AI_API_KEY 未配置')
  }
  return createModelFromConfig(config)
}

export async function checkContent(request: CheckRequest): Promise<CheckResponse> {
  const template = await getSystemPrompt('check')
  const prompt = renderPromptTemplate(template, {
    content: request.content,
    section: request.section || '',
  })

  try {
    const model = await getModel()
    const { object } = await generateObject({
      model,
      schema: z.object({
        suggestions: z.array(z.string()),
      }),
      prompt,
      temperature: 0.7,
    })

    return { suggestions: object.suggestions }
  } catch (error) {
    if (error instanceof AIConfigError) {
      return { suggestions: [error.message] }
    }
    console.error('checkContent error:', error)
    return { suggestions: [] }
  }
}

export async function polishEvent(
  content: string,
  systemPrompt: string,
  temperature: number,
): Promise<string> {
  const model = await getModel()
  const { object } = await generateObject({
    model,
    schema: z.object({ polishedContent: z.string() }),
    prompt: `${systemPrompt}\n\n请润色以下内容。保持原意不变，仅优化表达方式、补充数据感、调整句式。直接返回润色后文本，不要添加任何解释。\n内容中的 @数字（如 @7008）是对另一事件的引用，必须原样保留，不改写、不展开、不删除。\n\n${content}`,
    temperature,
  })
  return object.polishedContent
}

export async function expandSection(
  sectionTitle: string,
  existingItems: string[],
  events: string[],
  systemPrompt: string,
  temperature: number,
): Promise<Array<{ content: string; source: 'existing' | 'generated' }>> {
  const model = await getModel()
  const { object } = await generateObject({
    model,
    schema: z.object({
      newItems: z.array(z.string()),
    }),
    prompt: `${systemPrompt}\n\n章节标题：${sectionTitle}\n\n已有条目：\n${existingItems.join('\n')}\n\n可用事件素材：\n${events.join('\n')}\n\n请基于事件素材生成新的条目来补充这个章节。每条与已有条目不重复，格式与已有条目保持一致。仅输出新条目内容，不要扩写或修改已有条目。`,
    temperature,
  })

  const results: Array<{ content: string; source: 'existing' | 'generated' }> = existingItems.map(item => ({
    content: item,
    source: 'existing' as const,
  }))

  for (const item of object.newItems) {
    results.push({ content: item, source: 'generated' as const })
  }

  return results
}

export async function unifyStyle(
  content: string,
  systemPrompt: string,
  temperature: number,
): Promise<{ unifiedContent: string; changesCount: number }> {
  const model = await getModel()
  const { object } = await generateObject({
    model,
    schema: z.object({
      unifiedContent: z.string(),
      changesCount: z.number(),
    }),
    prompt: `${systemPrompt}\n\n请统一以下内容的写作风格。主要调整句式、用词和详略程度，保持内容信息量不变。\n\n${content}`,
    temperature,
  })

  return {
    unifiedContent: object.unifiedContent,
    changesCount: object.changesCount,
  }
}

export interface GenerateFinalReportRequest {
  sourceDraft: string
  template: string
  variant: 'leadership' | 'personal'
  weekStart: string
  weekEnd: string
  stylePrompt: string
}

export interface GenerateFinalReportResult {
  content: string
  summary: string[]
}

/** Generate one audience-specific final report from only its source draft. */
export async function generateFinalReport(
  request: GenerateFinalReportRequest,
  temperature: number,
): Promise<GenerateFinalReportResult> {
  const systemPrompt = await getSystemPrompt('generate')
  const model = await getModel()
  const { object } = await generateObject({
    model,
    schema: z.object({
      summary: z.array(z.string().min(1)).min(1).max(6),
      content: z.string().min(1),
    }),
    prompt: `${systemPrompt}

写作风格：
${request.stylePrompt}

受众版本：${request.variant === 'leadership' ? '领导版' : '个人版'}
日期范围：${request.weekStart} 至 ${request.weekEnd}

目标模板（原样理解，不要执行程序变量替换）：
---
${request.template}
---

当前受众版本的周报原稿（唯一事实来源）：
---
${request.sourceDraft}
---

结构化返回要求：
- summary：给用户查看的 2 至 6 条简短处理摘要，只说明采用了哪些模板章节、如何归类或合并原稿事实、哪些缺乏事实依据的内容被省略。
- summary 不得包含隐藏思维链、逐步内部推理、概率判断或未采用的草稿。
- content：完整的终版 Markdown 正文；“只返回终版 Markdown 正文”的规则仅约束此字段。
`,
    temperature,
  })

  return {
    content: object.content.trim(),
    summary: object.summary.map((item) => item.trim()).filter(Boolean),
  }
}
