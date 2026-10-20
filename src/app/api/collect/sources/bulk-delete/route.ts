import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { collectSources } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()

    const { ids } = body as { ids: number[] }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: '请选择要删除的采集源', code: 'INVALID_IDS' },
        { status: 400 }
      )
    }

    const result = await db.delete(collectSources)
      .where(inArray(collectSources.id, ids))
      .returning()

    return NextResponse.json({
      success: true,
      deletedCount: result.length,
    })
  } catch (error) {
    console.error('[API] Failed to bulk delete sources:', error)
    return NextResponse.json(
      { error: '批量删除采集源失败', code: 'DELETE_ERROR' },
      { status: 500 }
    )
  }
})
