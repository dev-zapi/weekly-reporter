import { describe, expect, it } from 'vitest'
import {
  buildEffectiveGenerationSystemPrompt,
  buildModelSystemContext,
  buildSourceOverview,
} from './context'

describe('generation context', () => {
  it('creates a deterministic compact overview without replacing the full source', () => {
    const source = `- **weekly-reporter**
  - 完成流式生成接口
  - 修复生产数据库迁移
- 参加项目评审并确认下一步计划`

    expect(buildSourceOverview(source, 'leadership')).toBe(
      '领导版 source draft: 3 events. 1 repositories/projects: weekly-reporter.\n1. 完成流式生成接口\n2. 修复生产数据库迁移\n3. 参加项目评审并确认下一步计划',
    )
  })

  it('keeps the complete source and template in model-only context', () => {
    const context = buildModelSystemContext({
      systemPrompt: 'SYSTEM',
      stylePrompt: 'STYLE',
      toolRules: 'TOOL',
      variant: 'personal',
      weekStart: '2026-08-10',
      weekEnd: '2026-08-16',
      templateName: '模板',
      templateContent: '# 本周成果',
      sourceDraft: '- 完整事实 A\n- 完整事实 B',
      latestProposalContent: '# 上一版',
    })

    expect(context).toContain('- 完整事实 A\n- 完整事实 B')
    expect(context).toContain('# 本周成果')
    expect(context).toContain('# 上一版')
    expect(context).not.toContain('计划结转')
    expect(context).not.toContain('计划覆盖记录')
  })

  it('makes the configured generation prompt visible inside the effective prompt', () => {
    const result = buildEffectiveGenerationSystemPrompt('只允许原稿事实')
    expect(result).toContain('只允许原稿事实')
    expect(result).toContain('propose_final_report')
  })

  it('applies the next-week plan only as a soft template-governed style rule', () => {
    const result = buildEffectiveGenerationSystemPrompt('只允许原稿事实')
    expect(result).toContain('若模板包含「下周计划」章节，以简洁列表陈述下周重点事项；模板未包含或明确禁止时，不添加该章节。')
    expect(result).not.toContain('plan.judgments')
    expect(result).not.toContain('最多保留五项')
  })
})
