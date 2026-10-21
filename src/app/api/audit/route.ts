import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { withAuth } from '@/lib/auth/guard'
import { apiAuditLog } from '@/lib/db/schema'
import { and, count, desc, eq, type SQL } from 'drizzle-orm'

/**
 * GET /api/audit
 *
 * Paginated audit log (newest first). Filters by PAT name, status and outcome.
 */
export const GET = withAuth(async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)

    const patName = searchParams.get('patName')
    const statusParam = searchParams.get('status')
    const outcome = searchParams.get('outcome')

    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50'), 1), 200)
    const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0)

    const conditions: SQL[] = []
    if (patName) conditions.push(eq(apiAuditLog.patName, patName))
    if (statusParam) {
      const status = parseInt(statusParam)
      if (!isNaN(status)) conditions.push(eq(apiAuditLog.status, status))
    }
    if (outcome === 'success' || outcome === 'unauthorized') {
      conditions.push(eq(apiAuditLog.outcome, outcome))
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const records = db
      .select()
      .from(apiAuditLog)
      .where(where)
      .orderBy(desc(apiAuditLog.createdAt), desc(apiAuditLog.id))
      .limit(limit)
      .offset(offset)
      .all()

    const totalRow = db
      .select({ value: count() })
      .from(apiAuditLog)
      .where(where)
      .get()

    return NextResponse.json({
      records,
      total: totalRow?.value ?? 0,
      limit,
      offset,
    })
  } catch (error) {
    console.error('Error fetching audit log:', error)
    return NextResponse.json(
      { error: 'Failed to fetch audit log', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
})
