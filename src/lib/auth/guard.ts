import 'server-only'
import crypto from 'node:crypto'
import { getDb } from '@/lib/db'
import { writeAudit, recordAudit } from './audit'
import { readStartupPassword } from './password'
import { findPatByToken, isPatExpired, isPatRevoked, touchPat } from './pat'
import { parseIncomingTraceId } from '@/lib/trace/ids'
import { applyTraceResponseHeaders, runWithTrace } from '@/lib/trace/context'
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

/**
 * 私有 key：`withAuth` 鉴权成功后把 `AuthResult` 挂到 request 上，handler 通过
 * `getAuthResult` 读取，避免在 handler 里再跑一遍 `requireAuth`（重复 DB 查询 /
 * 重复 `touchPat`，且可能写出与审计行不一致的判定）。Symbol key 不出现在
 * `Object.keys` / JSON 序列化里，也不改 handler 签名，Next 16 的 route 类型校验
 * 不受影响。
 */
const AUTH_RESULT = Symbol('weekly-reporter.auth-result')

interface AuthenticatedRequest extends Request {
  [AUTH_RESULT]?: AuthResult
}

/**
 * 读取 `withAuth` 为本次请求解析出的 `AuthResult`；请求未经过 `withAuth` 时返回
 * undefined。
 */
export function getAuthResult(request: Request): AuthResult | undefined {
  return (request as AuthenticatedRequest)[AUTH_RESULT]
}

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
 *
 * 这里同时是 trace 的强制入口：整条请求链路跑在 `runWithTrace` 里（类 Spring
 * Sleuth 的根 span），错误响应与成功响应都会补上 trace 响应头。routes 无需任何
 * 改动即可获得该能力。
 */
export function withAuth<H extends (...args: never[]) => unknown>(
  handler: H,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>> {
  return (async (...args: Parameters<H>) => {
    const [req] = args as unknown as [Request, ...unknown[]]
    // 请求可能不存在（无参 route、测试里 GET() 直呼），headers 访问前判空。
    const incomingTraceId =
      req && typeof req === 'object' && req.headers ? parseIncomingTraceId(req.headers) : null

    return runWithTrace(
      async () => {
        const auth = await requireAuth(req)
        if (!auth.ok) {
          // 早退路径同样要带 trace 头：PAT 失效是最常见的故障，排障时需要 trace id。
          if (auth.response) applyTraceResponseHeaders(auth.response)
          return auth.response as Response
        }
        // 把判定结果交给 handler，省掉 handler 里对 requireAuth 的二次调用。
        // handler 不接 request（例如无参 route、测试里 GET() 直呼）时无可挂载对象，
        // 跳过即可——这类 handler 也不会去读 getAuthResult。
        if (req && typeof req === 'object') {
          Object.defineProperty(req, AUTH_RESULT, {
            value: auth,
            enumerable: false,
            configurable: true,
          })
        }

        let res: Response
        try {
          res = (await handler(...args)) as Response
        } catch (error) {
          // 未捕获异常交给 Next 转 500；这里先落一条日志，console 补丁会自动带上 trace 前缀。
          console.error('Unhandled route handler error:', error)
          throw error
        }

        applyTraceResponseHeaders(res)
        await recordAudit(getDb, req, res.status, auth)
        return res
      },
      incomingTraceId ? { traceId: incomingTraceId } : undefined,
    )
  }) as (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>>
}
