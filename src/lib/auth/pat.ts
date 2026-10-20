import 'server-only'
import crypto from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { apiTokens, type ApiToken } from '@/lib/db/schema'
import { randomBase62 } from './random'
import type { CreatedPat, PatMetadata } from './pat-shared'

/**
 * PAT（Personal Access Token）
 *
 * 服务端签发、给脚本 / agent 用的 API 访问令牌。服务端只存 SHA-256 哈希，
 * 明文仅在创建时返回一次。一个 PAT 拥有全部 `/api/**` 权限（无 scope）。
 */

const TOKEN_PREFIX = 'wrp_'
const TOKEN_RANDOM_LENGTH = 32
/** prefix 字段存明文前 8 位，如 `wrp_a1b2` */
export const TOKEN_DISPLAY_PREFIX_LENGTH = 8

type DrizzleDb = ReturnType<typeof getDb>

// 类型与状态推导与服务端 / 客户端共享；pat.ts 作为服务端入口继续 re-export，
// 既有 `import { type PatMetadata } from '@/lib/auth/pat'` 调用方不受影响。
export type { CreatedPat, PatMetadata } from './pat-shared'
export { getPatStatus, type PatStatus } from './pat-shared'

/**
 * SHA-256 十六进制哈希。PAT 只以哈希形式落盘。
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * 生成明文 PAT：`wrp_` + 32 位 base62。
 */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBase62(TOKEN_RANDOM_LENGTH)}`
}

export function getTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH)
}

/**
 * 创建一个 PAT，返回明文（只此一次）。
 */
export function createPat(
  db: DrizzleDb,
  name: string,
  options: { expiresAt?: number | null } = {},
): CreatedPat {
  const token = generateToken()
  const now = Date.now()
  const expiresAt = options.expiresAt ?? null

  const inserted = db
    .insert(apiTokens)
    .values({
      name,
      tokenHash: hashToken(token),
      prefix: getTokenPrefix(token),
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    })
    .returning()
    .all()

  return {
    id: inserted[0].id,
    name: inserted[0].name,
    token,
    createdAt: inserted[0].createdAt,
  }
}

/**
 * 按哈希查 PAT；查不到返回 null。
 */
export function findPatByToken(db: DrizzleDb, token: string): ApiToken | null {
  const rows = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashToken(token)))
    .limit(1)
    .all()
  return rows[0] ?? null
}

export function isPatRevoked(pat: ApiToken): boolean {
  return pat.revokedAt !== null
}

export function isPatExpired(pat: ApiToken, now: number = Date.now()): boolean {
  if (pat.expiresAt === null) return false
  return pat.expiresAt <= now
}

/**
 * 吊销 PAT：置 `revoked_at`，不删行（保留审计可追溯性）。
 * 返回是否命中了一行。
 */
export function revokePat(db: DrizzleDb, id: number): boolean {
  const revoked = db
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning()
    .all()
  return revoked.length > 0
}

/**
 * 更新 `last_used_at`。
 */
export function touchPat(db: DrizzleDb, id: number): void {
  db.update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, id)).run()
}

/**
 * 列出全部 PAT 的元数据（不含 `token_hash`、不含明文）。
 */
export function listPats(db: DrizzleDb): PatMetadata[] {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
    .all()
}
