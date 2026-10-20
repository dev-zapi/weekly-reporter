import 'server-only'
import { getDb } from '@/lib/db'
import { apiAuditLog } from '@/lib/db/schema'
import { extractCallerIdentity } from './identity'
import type { AuthMode, AuthOutcome } from './types'

/**
 * 审计记录（Audit Record）
 *
 * 一次经 PAT 鉴权的 API 调用留下的痕迹。浏览器（启动密码）调用不记。
 * 失败也记（`status=401`，`outcome='unauthorized'`）—— 脚本 PAT 失效 / 被吊销
 * 是 PAT 场景最常见故障，不记则排障无迹可寻。
 *
 * 审计写失败不得影响业务响应：内部 try/catch，失败只记 console.error。
 */

type DrizzleDb = ReturnType<typeof getDb>

export interface AuditInput {
  status: number
  patName: string | null
  method: string
  apiPath: string
  userAgent: string | null
  agentIdentity: string | null
  callerCwd: string | null
  outcome: AuthOutcome
}

function buildAuditInput(
  request: Request,
  status: number,
  patName: string | null,
): AuditInput {
  const { agentIdentity, callerCwd } = extractCallerIdentity(request)
  return {
    status,
    patName,
    method: request.method,
    apiPath: new URL(request.url).pathname,
    userAgent: request.headers.get('user-agent'),
    agentIdentity,
    callerCwd,
    outcome: status === 401 ? 'unauthorized' : 'success',
  }
}

function writeAuditRecord(db: DrizzleDb, input: AuditInput): void {
  db.insert(apiAuditLog)
    .values({
      createdAt: Date.now(),
      patName: input.patName,
      method: input.method,
      apiPath: input.apiPath,
      status: input.status,
      userAgent: input.userAgent,
      agentIdentity: input.agentIdentity,
      callerCwd: input.callerCwd,
      outcome: input.outcome,
    })
    .run()
}

/**
 * 写一行审计。失败只记日志，不抛出。
 */
export function writeAudit(
  db: DrizzleDb,
  request: Request,
  status: number,
  patName: string | null,
): void {
  try {
    writeAuditRecord(db, buildAuditInput(request, status, patName))
  } catch (error) {
    console.error('Failed to write audit record:', error)
  }
}

/**
 * 鉴权成功后的审计：只有 PAT 模式才真正落库，浏览器调用与总开关关闭都不记。
 *
 * `getDatabase` 是惰性的：非 PAT 模式不会去开数据库连接。
 */
export async function recordAudit(
  getDatabase: () => DrizzleDb,
  request: Request,
  status: number,
  auth: { mode: AuthMode; patName?: string | null },
): Promise<void> {
  if (auth.mode !== 'pat') return
  writeAudit(getDatabase(), request, status, auth.patName ?? null)
}
