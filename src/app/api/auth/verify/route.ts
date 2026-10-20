import { NextResponse } from 'next/server'
import { withAuth, getAuthResult } from '@/lib/auth/guard'

/**
 * GET /api/auth/verify
 *
 * Lightweight authentication check. Valid credentials → 200 with mode.
 * Itself wrapped in withAuth so audit rows are recorded for PAT mode.
 *
 * The handler reads the AuthResult `withAuth` already resolved instead of
 * calling requireAuth again — a second call would repeat the DB lookup /
 * `touchPat` and could disagree with the audit row written by withAuth.
 */
export const GET = withAuth(async function GET(request: Request) {
  const auth = getAuthResult(request)

  if (!auth) {
    // Unreachable through withAuth (it only invokes the handler on success);
    // kept as an explicit, fail-closed guard rather than a non-null assertion.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({ ok: true, mode: auth.mode })
})
