import { NextResponse } from 'next/server'
import { withAuth, requireAuth, isAuthDisabled } from '@/lib/auth/guard'

/**
 * GET /api/auth/verify
 *
 * Lightweight authentication check. Valid credentials → 200 with mode.
 * Itself wrapped in withAuth so audit rows are recorded for PAT mode.
 */
export const GET = withAuth(async function GET(request: Request) {
  const auth = await requireAuth(request)

  if (!auth.ok) {
    return auth.response!
  }

  return NextResponse.json({ ok: true, mode: auth.mode })
})
