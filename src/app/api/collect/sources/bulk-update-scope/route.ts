import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { collectSources, ProjectScope } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    
    const { ids, projectScope } = body as { 
      ids: number[]
      projectScope: ProjectScope 
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: '请选择要更新的采集源', code: 'INVALID_IDS' },
        { status: 400 }
      )
    }

    if (!projectScope || !['work', 'personal'].includes(projectScope)) {
      return NextResponse.json(
        { error: '项目类型必须是 work 或 personal', code: 'INVALID_SCOPE' },
        { status: 400 }
      )
    }

    const result = await db.update(collectSources)
      .set({
        projectScope,
        updatedAt: new Date(),
      })
      .where(inArray(collectSources.id, ids))
      .returning()

    return NextResponse.json({
      success: true,
      updatedCount: result.length,
    })
  } catch (error) {
    console.error('[API] Failed to bulk update project scope:', error)
    return NextResponse.json(
      { error: '批量更新项目类型失败', code: 'UPDATE_ERROR' },
      { status: 500 }
    )
  }
})