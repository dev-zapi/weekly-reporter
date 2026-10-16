import { z } from 'zod'
import { expandInputPath, stripTrailingSlash } from '@/lib/collect/paths'
import { TAG_CHARSET_REGEX } from '@/lib/tags'

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/
export const MONTH_REGEX = /^\d{4}-\d{2}$/

export const reportWeekSchema = z.object({
  weekStart: z.string().regex(DATE_REGEX, 'Date must use YYYY-MM-DD format'),
  weekEnd: z.string().regex(DATE_REGEX, 'Date must use YYYY-MM-DD format'),
}).refine(
  (data) => new Date(data.weekStart) <= new Date(data.weekEnd),
  {
    message: 'Start date cannot be later than end date',
    path: ['weekEnd'],
  },
)

export const createReportSchema = reportWeekSchema.safeExtend({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be 200 characters or fewer'),
})

export type CreateReportInput = z.infer<typeof createReportSchema>

export const templateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(100),
  content: z.string().min(1, 'Template content is required'),
  description: z.string().max(200).optional(),
  tags: z.string().optional(),
  aiStyle: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
})

export const cloneTemplateSchema = z.object({
  sourceId: z.string().min(1, 'Source template ID is required'),
  name: z.string().min(1, 'Template name is required').max(100).optional(),
  content: z.string().optional(),
})

export type TemplateInput = z.infer<typeof templateSchema>
export type CloneTemplateInput = z.infer<typeof cloneTemplateSchema>

export const collectSourceSchema = z.object({
  type: z.enum(['git-remote-github', 'git-remote-gitlab', 'git-remote-gitee', 'git-local']),
  name: z.string().min(1, 'Source name is required').max(100),
  projectScope: z.enum(['work', 'personal']),
  aliases: z.array(z.string().min(1).max(100)).max(20).optional(),
  config: z.object({
    baseUrl: z.string().optional(),
    owner: z.string().min(1, 'Path or owner is required'),
    repo: z.string().optional(),
    token: z.string().optional(),
    authorEmails: z.array(z.string()).min(1, 'At least one author email is required'),
    branches: z.array(z.union([
      z.string(),
      z.object({ name: z.string(), lastCommitTime: z.string().nullable().optional() })
    ])).optional(),
    branchCursors: z.array(z.object({ name: z.string(), lastCommitTime: z.string().nullable().optional() })).optional(),
  }),
  enabled: z.boolean().optional(),
}).refine(
  (data) => {
    if (data.type === 'git-local') {
      return true
    }
    return data.config.repo && data.config.repo.length > 0
  },
  {
        message: 'A repository is required for remote sources',
    path: ['config', 'repo'],
  }
).refine(
  (data) => {
    if (data.type === 'git-local') {
      return true
    }
    return data.config.token && data.config.token.length > 0
  },
  {
        message: 'A token is required for remote sources',
    path: ['config', 'token'],
  }
).transform(
  // git-local 的路径是用户直接输入的：统一做路径展开（见 CONTEXT.md「路径展开」），
  // 并去掉结尾斜杠，保证落库的 owner 与扫描得来的路径形态一致
  (data) => {
    if (data.type !== 'git-local') return data
    return {
      ...data,
      config: {
        ...data.config,
        owner: stripTrailingSlash(expandInputPath(data.config.owner)),
      },
    }
  }
)

export type CollectSourceInput = z.infer<typeof collectSourceSchema>

// --- AI 风格校验 ---

const styleKeyRegex = /^[a-z][a-z0-9_-]*$/

export const aiStyleSchema = z.object({
  key: z.string().min(1, 'Key is required').max(50).regex(styleKeyRegex, 'Key must start with a letter and contain only lowercase letters, numbers, hyphens, and underscores'),
  label: z.string().min(1, 'Name is required').max(50),
  systemPrompt: z.string().min(1, 'System prompt is required').max(5000),
  temperature: z.number().min(0).max(2).default(0.3),
  detailLevel: z.enum(['low', 'medium', 'high']).optional(),
  resultOriented: z.enum(['low', 'medium', 'high']).optional(),
  isDefault: z.boolean().optional(),
})

export type AIStyleInput = z.infer<typeof aiStyleSchema>

// --- 系统提示词校验 ---

export const systemPromptSchema = z.object({
  promptText: z.string().min(1, 'Prompt is required').max(10000),
})

export type SystemPromptInput = z.infer<typeof systemPromptSchema>

// --- 标签重命名校验 ---

const tagCharsetMessage = 'Tag name may contain only Chinese characters, letters, and digits'

export const tagRenameSchema = z.object({
  from: z.string().regex(TAG_CHARSET_REGEX, tagCharsetMessage),
  to: z.string().regex(TAG_CHARSET_REGEX, tagCharsetMessage),
})

export type TagRenameInput = z.infer<typeof tagRenameSchema>
