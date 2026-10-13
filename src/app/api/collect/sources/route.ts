import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { getDb } from '@/lib/db'
import { asc, desc, isNull, or, sql, count } from 'drizzle-orm'
import { like, and, eq } from 'drizzle-orm'
import { collectSources } from '@/lib/db/schema'
import { collectSourceSchema } from '@/lib/validations'

const SORTABLE_COLUMNS = ['name', 'type', 'projectScope', 'lastSyncAt', 'status'] as const
type SortBy = (typeof SORTABLE_COLUMNS)[number]

const COLUMN_MAP = {
  name: collectSources.name,
  type: collectSources.type,
  projectScope: collectSources.projectScope,
  lastSyncAt: collectSources.lastSyncAt,
  status: collectSources.status,
}

export async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')
    const name = searchParams.get('name') || ''
    const type = searchParams.get('type') || ''
    const syncStatus = searchParams.get('syncStatus') || ''
    const sourceStatus = searchParams.get('sourceStatus') || ''
    const projectScope = searchParams.get('projectScope') || ''
    const sortByRaw = searchParams.get('sortBy') || ''
    const sortOrder = searchParams.get('sortOrder') || 'desc'

    const sortBy: SortBy | '' = SORTABLE_COLUMNS.includes(sortByRaw as SortBy) ? (sortByRaw as SortBy) : ''

    const offset = (page - 1) * pageSize

    const conditions = []
    if (type) {
      conditions.push(eq(collectSources.type, type))
    }
    if (name) {
      conditions.push(
        or(
          like(collectSources.name, `%${name}%`),
          sql`EXISTS (SELECT 1 FROM json_each(${collectSources.config}, '$.aliases') WHERE json_each.value LIKE ${`%${name}%`})`
        )
      )
    }
    if (syncStatus === 'success' || syncStatus === 'failure') {
      conditions.push(eq(collectSources.lastSyncStatus, syncStatus))
    } else if (syncStatus === 'never') {
      conditions.push(isNull(collectSources.lastSyncAt))
    }
    if (sourceStatus === 'enabled' || sourceStatus === 'disabled' || sourceStatus === 'unavailable') {
      conditions.push(eq(collectSources.status, sourceStatus))
    }
    if (projectScope === 'work' || projectScope === 'personal') {
      conditions.push(eq(collectSources.projectScope, projectScope))
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const orderByCol = sortBy ? COLUMN_MAP[sortBy] : collectSources.lastSyncAt
    const orderFn = sortOrder === 'asc' ? asc : desc
    const orderBy = [orderFn(orderByCol)]

    const sources = await db.query.collectSources.findMany({
      where: whereClause,
      orderBy,
      limit: pageSize,
      offset,
    })

    const totalResult = await db.select({ count: count() }).from(collectSources).where(whereClause)
    const total = totalResult[0].count

    return NextResponse.json({
      sources: sources.map(s => ({
        ...s,
        config: {
          ...s.config,
          token: '[ENCRYPTED]',
        },
      })),
      total,
      page,
      pageSize,
    })
  } catch (error) {
    console.error('[API] Failed to fetch collect sources:', error)
    return NextResponse.json(
      { error: '获取采集源列表失败', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()

    const validated = collectSourceSchema.parse(body)

    // Check alias uniqueness across all sources
    if (validated.aliases && validated.aliases.length > 0) {
      const allSources = await db.query.collectSources.findMany()
      const existingAliases = new Set(
        allSources.flatMap(s => (s.config.aliases as string[]) || [])
      )
      const duplicates = validated.aliases.filter(a => existingAliases.has(a))
      if (duplicates.length > 0) {
        return NextResponse.json(
          { error: `别名已被使用: ${duplicates.join(', ')}`, code: 'DUPLICATE_ALIAS' },
          { status: 400 }
        )
      }
    }

    const now = new Date()
    // 没有配置邮箱时，状态自动设为 unavailable
    const hasEmails = validated.config?.authorEmails && validated.config.authorEmails.length > 0
    const initialStatus = hasEmails
      ? (validated.enabled === false ? 'disabled' : 'enabled')
      : 'unavailable'

    // 规范化 branchCursors（zod schema 允许 undefined，但数据库 schema 要求 string | null）
    const normalizedConfig = {
      ...validated.config,
      branchCursors: validated.config.branchCursors?.map(c => ({
        name: c.name,
        lastCommitTime: c.lastCommitTime ?? null,
      })),
      // 别名的存储位置是 config.aliases（列表的名称搜索与查重都从这里读），
      // 而 zod 校验的是顶层 aliases —— 不在此并入的话，提交的别名会被静默丢弃
      ...(validated.aliases?.length ? { aliases: validated.aliases } : {}),
    }

    const result = await db.insert(collectSources).values({
      ...validated,
      config: normalizedConfig,
      status: initialStatus,
      createdAt: now,
      updatedAt: now,
    }).returning()

    return NextResponse.json({
      ...result[0],
      config: {
        ...result[0].config,
        token: '[ENCRYPTED]',
      },
    }, { status: 201 })
  } catch (error) {
    console.error('[API] Failed to create collect source:', error)
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
      { error: '创建采集源失败', code: 'CREATE_ERROR' },
      { status: 500 }
    )
  }
}