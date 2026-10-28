import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { withAuth } from '@/lib/auth/guard'
import { revokePat } from '@/lib/auth/pat'
import { eq } from 'drizzle-orm'
import { apiTokens } from '@/lib/db/schema'

/**
 * DELETE /api/auth/pats/[id]
 *
 * Revoke a PAT (set revoked_at, keep row for audit trail).
 */
// Request（而非 NextRequest）：本 handler 不读任何 Next 扩展字段，取最小类型，
// 单测也可以直接用原生 Request 构造调用。
export const DELETE = withAuth(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: paramId } = await params
    const id = parseInt(paramId)

    if (isNaN(id)) {
      return NextResponse.json(
        { error: 'Invalid PAT ID', code: 'INVALID_ID' },
        { status: 400 }
      )
    }

    const db = getDb()

    // Check if PAT exists
    const pat = db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1)
      .get()

    if (!pat) {
      return NextResponse.json(
        { error: 'PAT not found', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }

    revokePat(db, id)

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('Error revoking PAT:', error)
    return NextResponse.json(
      { error: 'Failed to revoke PAT', code: 'REVOKE_ERROR' },
      { status: 500 }
    )
  }
})
