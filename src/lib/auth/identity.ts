import { AGENT_IDENTITY_HEADER, CALLER_CWD_HEADER } from './types'

/**
 * 调用方自报身份。
 *
 * 脚本在发请求时附带 `X-Weekly-Reporter-Agent`（skill 名 + agent 名）与
 * `X-Weekly-Reporter-Cwd`（`process.cwd()`）两个头。两者都不可信（调用方自报），
 * 仅作归因线索，不作安全依据。
 */

export interface CallerIdentity {
  /** 调用方自报的 agent 身份，如 `weekly-reports/claude-code` */
  agentIdentity: string | null
  /** 调用方自报的工作目录 */
  callerCwd: string | null
}

export function extractCallerIdentity(request: Request): CallerIdentity {
  return {
    agentIdentity: request.headers.get(AGENT_IDENTITY_HEADER),
    callerCwd: request.headers.get(CALLER_CWD_HEADER),
  }
}
