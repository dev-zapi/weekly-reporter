import 'server-only'
import crypto from 'node:crypto'
import { getDb } from '@/lib/db'
import { writeAudit, recordAudit } from './audit'
import { readStartupPassword } from './password'
import { findPatByToken, isPatExpired, isPatRevoked, touchPat } from './pat'
import type { AuthResult } from './types'

/**
 * 认证守卫。
 *
 * 双模式：`Authorization: Bearer <token>`，token 或是启动密码（浏览器）或是 PAT（脚本）。
 *
 * `withAuth` 用 HOF 形态而非「守卫作为首行」—— HOF 在 handler 返回之后能拿到真实的
 * `res.status`，审计的 `status` 字段才有正确值。
 */

const BEARER_PREFIX = 'Bearer '

export function isAuthDisabled(): boolean {
  return process.env.WR_AUTH_DISABLED === '1'
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 常量时间比较：先对两侧取 SHA-256 再比，长度不等也不会泄漏长度侧信道。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest()
  const hashB = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(hashA, hashB)
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header || !header.startsWith(BEARER_PREFIX)) return null
  const token = header.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : null
}

/**
 * 判定请求的认证方式。
 *
 * 判定顺序：总开关 → Bearer 头 → 启动密码 → PAT。
 * 失败一律 401（不是 500）：密码文件缺失 / 损坏 / 读失败时也只返回 401。
 */
export async function requireAuth(request: Request): Promise<AuthResult> {
  if (isAuthDisabled()) {
    return { ok: true, mode: 'disabled' }
  }

  const token = extractBearerToken(request)
  if (!token) {
    return { ok: false, mode: 'pat', response: unauthorized() }
  }

  const password = readStartupPassword()
  if (password && timingSafeEqualString(password, token)) {
    return { ok: true, mode: 'password' }
  }

  const db = getDb()
  const pat = findPatByToken(db, token)

  if (!pat) {
    // 认不出是哪个 PAT，pat_name 只能为空。
    writeAudit(db, request, 401, null)
    return { ok: false, mode: 'pat', response: unauthorized() }
  }

  if (isPatRevoked(pat) || isPatExpired(pat)) {
    writeAudit(db, request, 401, pat.name)
    return { ok: false, mode: 'pat', response: unauthorized() }
  }

  touchPat(db, pat.id)
  return { ok: true, mode: 'pat', patName: pat.name }
}

/**
 * 用 `withAuth` 包住导出的 route handler。
 *
 * 返回类型与原 handler 相同（参数与返回类型都不变），因此 Next 16 的 route 类型
 * 校验与既有单测的调用形态都不受影响。第二参数 `ctx` 原样透传（含 Next 16 的
 * `params` Promise），不改其类型。
 */
export function withAuth<H extends (...args: any[]) => any>(handler: H): H {
  return (async (...args: any[]) => {
    const [req, ctx] = args as [Request, unknown]
    const auth = await requireAuth(req)
    if (!auth.ok) return auth.response as Response
    const res = await handler(...args)
    await recordAudit(getDb, req, res.status, auth)
    return res
  }) as H
}
