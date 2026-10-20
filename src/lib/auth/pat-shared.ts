import type { AuthOutcome } from './types'

/**
 * PAT / audit 形状与状态推导的共享模块。
 *
 * 服务端（pat.ts）与客户端安全页（app/security/page.tsx）此前各自镜像了一份
 * `PatMetadata` / `CreatedPat` / `AuditRecord` 和 `getPatStatus`，字段一旦改动就
 * 会两边漂移。这里作为唯一来源。
 *
 * 刻意不含 `server-only`、不 import db：安全页是 `'use client'`，要能直接 import
 * 本模块。真正的数据库访问仍留在 pat.ts。
 */

export interface PatMetadata {
  id: number
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

export interface CreatedPat {
  id: number
  name: string
  /** 明文 token —— 只在创建时返回一次 */
  token: string
  createdAt: number
}

export interface AuditRecord {
  id: number
  createdAt: number
  patName: string | null
  method: string
  apiPath: string
  status: number
  userAgent: string | null
  agentIdentity: string | null
  callerCwd: string | null
  outcome: AuthOutcome
}

export type PatStatus = 'active' | 'revoked' | 'expired'

/**
 * 展示用状态：revoked 优先于 expired（已吊销的 PAT 即使也过期，也按 revoked 显示）。
 */
export function getPatStatus(pat: PatMetadata): PatStatus {
  if (pat.revokedAt !== null) return 'revoked'
  if (pat.expiresAt !== null && pat.expiresAt < Date.now()) return 'expired'
  return 'active'
}
