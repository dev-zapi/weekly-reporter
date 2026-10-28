import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { withAuth } from '@/lib/auth/guard'
import { createPat, listPats } from '@/lib/auth/pat'

/**
 * GET /api/auth/pats
 *
 * List all PAT metadata (no token_hash, no plaintext).
 */
// _request 未使用，但必须声明：withAuth 从第一个参数取请求做鉴权与审计挂载，
// Next 运行时也总是会把请求传进来（与其它 route 及其单测的调用形态一致）。
export const GET = withAuth(async function GET(_request: Request) {
  try {
    const db = getDb()
    const pats = listPats(db)
    return NextResponse.json({ pats })
  } catch (error) {
    console.error('Error listing PATs:', error)
    return NextResponse.json(
      { error: 'Failed to list PATs', code: 'LIST_ERROR' },
      { status: 500 }
    )
  }
})

/**
 * POST /api/auth/pats
 *
 * Create a new PAT. Returns plaintext token once.
 */
export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, expiresAt } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'name is required and must be a non-empty string', code: 'INVALID_NAME' },
        { status: 400 }
      )
    }

    const db = getDb()
    const pat = createPat(db, name.trim(), { expiresAt })

    return NextResponse.json(pat, { status: 201 })
  } catch (error) {
    console.error('Error creating PAT:', error)
    return NextResponse.json(
      { error: 'Failed to create PAT', code: 'CREATE_ERROR' },
      { status: 500 }
    )
  }
})
