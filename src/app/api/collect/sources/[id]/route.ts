import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { collectSources } from '@/lib/db/schema'
import { collectSourceSchema } from '@/lib/validations'
import { mergeEditedBranches } from '@/lib/collect/branches'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const sourceId = parseInt(id)
    
    if (isNaN(sourceId)) {
      return NextResponse.json(
        { error: '无效的采集源ID', code: 'INVALID_ID' },
        { status: 400 }
      )
    }
    
    const source = await db.query.collectSources.findFirst({
      where: eq(collectSources.id, sourceId),
    })
    
    if (!source) {
      return NextResponse.json(
        { error: '采集源不存在', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({
      ...source,
      config: {
        ...source.config,
        token: '[ENCRYPTED]',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: '获取采集源失败', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const sourceId = parseInt(id)

    if (isNaN(sourceId)) {
      return NextResponse.json(
        { error: '无效的采集源ID', code: 'INVALID_ID' },
        { status: 400 }
      )
    }

    const existing = await db.query.collectSources.findFirst({
      where: eq(collectSources.id, sourceId),
    })

    if (!existing) {
      return NextResponse.json(
        { error: '采集源不存在', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }

    const body = await request.json() as Record<string, unknown>
    const bodyConfig = (body.config && typeof body.config === 'object' ? body.config : {}) as Record<string, unknown>
    const existingConfig = existing.config
    const bodyType = body.type
    const shouldKeepToken = bodyType !== 'git-local' && (!bodyConfig.token || bodyConfig.token === '[ENCRYPTED]')
    const normalizedBody = shouldKeepToken && existingConfig.token
      ? { ...body, config: { ...bodyConfig, token: existingConfig.token } }
      : body
    const validated = collectSourceSchema.parse(normalizedBody)

    // Check alias uniqueness across all sources (excluding current source's own aliases)
    if (validated.aliases && validated.aliases.length > 0) {
      const allSources = await db.query.collectSources.findMany()
      const existingAliases = new Set(
        allSources
          .filter(s => s.id !== sourceId) // exclude current source
          .flatMap(s => (s.config.aliases as string[]) || [])
      )
      const duplicates = validated.aliases.filter(a => existingAliases.has(a))
      if (duplicates.length > 0) {
        return NextResponse.json(
          { error: `别名已被使用: ${duplicates.join(', ')}`, code: 'DUPLICATE_ALIAS' },
          { status: 400 }
        )
      }
    }

    // 检查邮箱配置：如果没有邮箱，状态自动设为 unavailable
    const hasEmails = validated.config?.authorEmails && validated.config.authorEmails.length > 0
    const newStatus = hasEmails
      ? (validated.enabled === false ? 'disabled' : 'enabled')
      : 'unavailable'

    const normalizedBranches = mergeEditedBranches(existingConfig.branches, validated.config.branches)
    // 保留全分支模式下累积的游标（表单不发送该字段，防止每次编辑清空游标导致全量重扫）
    const preservedCursors = existingConfig.branchCursors?.map(c => ({
      name: c.name,
      lastCommitTime: c.lastCommitTime ?? null,
    }))
    const { branchCursors: _validatedCursors, ...validatedConfigWithoutCursors } = validated.config
    const config = {
      ...validatedConfigWithoutCursors,
      ...(normalizedBranches && normalizedBranches.length > 0 ? { branches: normalizedBranches } : { branches: undefined }),
      ...(preservedCursors ? { branchCursors: preservedCursors } : {}),
    }

    const result = await db.update(collectSources)
      .set({
        ...validated,
        config,
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(collectSources.id, sourceId))
      .returning()

    return NextResponse.json({
      ...result[0],
      config: {
        ...result[0].config,
        token: '[ENCRYPTED]',
      },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      const issues = (error as ZodError).issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
      return NextResponse.json(
        { error: '数据验证失败', code: 'VALIDATION_ERROR', details: { issues } },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: '更新采集源失败', code: 'UPDATE_ERROR' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const sourceId = parseInt(id)

    if (isNaN(sourceId)) {
      return NextResponse.json(
        { error: '无效的采集源ID', code: 'INVALID_ID' },
        { status: 400 }
      )
    }

    const body = await request.json()

    const existing = await db.query.collectSources.findFirst({
      where: eq(collectSources.id, sourceId),
    })

    if (!existing) {
      return NextResponse.json(
        { error: '采集源不存在', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }

    // 只允许 PATCH 已知的安全字段
    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if ('enabled' in body) updates.enabled = Boolean(body.enabled)
    if ('status' in body) {
      const validStatuses = ['enabled', 'disabled', 'unavailable']
      if (validStatuses.includes(body.status)) {
        updates.status = body.status
      }
    }

    // 处理分支删除
    if ('removeBranch' in body && typeof body.removeBranch === 'string') {
      const branchName = body.removeBranch
      const config = existing.config

      if (!config.branches || !Array.isArray(config.branches)) {
        return NextResponse.json(
          { error: '采集源没有分支配置', code: 'NO_BRANCHES' },
          { status: 400 }
        )
      }

      const branchIndex = config.branches.findIndex((b) =>
        (typeof b === 'string' ? b : b.name) === branchName
      )
      if (branchIndex === -1) {
        return NextResponse.json(
          { error: `分支 ${branchName} 不存在`, code: 'BRANCH_NOT_FOUND' },
          { status: 404 }
        )
      }

      if (config.branches.length === 1) {
        return NextResponse.json(
          { error: '至少保留一个分支', code: 'LAST_BRANCH' },
          { status: 400 }
        )
      }

      // 删除分支
      const updatedBranches = [...config.branches]
      updatedBranches.splice(branchIndex, 1)
      updates.config = { ...config, branches: updatedBranches }
    }

    const result = await db.update(collectSources)
      .set(updates)
      .where(eq(collectSources.id, sourceId))
      .returning()

    return NextResponse.json({
      ...result[0],
      config: {
        ...result[0].config,
        token: '[ENCRYPTED]',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: '更新采集源失败', code: 'UPDATE_ERROR' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const sourceId = parseInt(id)
    
    if (isNaN(sourceId)) {
      return NextResponse.json(
        { error: '无效的采集源ID', code: 'INVALID_ID' },
        { status: 400 }
      )
    }
    
    const existing = await db.query.collectSources.findFirst({
      where: eq(collectSources.id, sourceId),
    })
    
    if (!existing) {
      return NextResponse.json(
        { error: '采集源不存在', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }
    
    await db.delete(collectSources).where(eq(collectSources.id, sourceId))
    
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: '删除采集源失败', code: 'DELETE_ERROR' },
      { status: 500 }
    )
  }
}
