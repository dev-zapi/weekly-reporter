import 'server-only'
import { getAuthResult } from '@/lib/auth/guard'
import { extractCallerIdentity } from '@/lib/auth/identity'
import type { AuthResult } from '@/lib/auth/types'

/**
 * Derive a comment's author marker at the route boundary.
 *
 * Browser callers (startup password or auth-disabled mode) store null and render
 * as the user. PAT callers store their self-reported agent identity, falling
 * back to the token name and finally the literal `pat`. Attribution only —
 * exactly like the audit log, never a security boundary.
 */
export function deriveCommentAuthor(
  request: Request,
  auth: AuthResult | undefined = getAuthResult(request),
): string | null {
  if (!auth || auth.mode !== 'pat') return null
  const { agentIdentity } = extractCallerIdentity(request)
  return agentIdentity ?? auth.patName ?? 'pat'
}
