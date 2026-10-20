/**
 * 共享类型：认证判定结果与审计模式。
 *
 * `AuthMode` 区分调用来源，决定是否写审计：
 * - `disabled`：总开关关闭，放行且不记审计
 * - `password`：浏览器用启动密码调用，不记审计
 * - `pat`：脚本 / agent 用 PAT 调用，记审计
 */
export type AuthMode = 'disabled' | 'password' | 'pat'

export type AuthOutcome = 'success' | 'unauthorized'

export interface AuthResult {
  ok: boolean
  mode: AuthMode
  /** 命中的 PAT 名称；密码模式与无法识别 PAT 的失败为 null */
  patName?: string | null
  /** 失败时的 401 响应；成功时为 undefined */
  response?: Response
}

export const AGENT_IDENTITY_HEADER = 'X-Weekly-Reporter-Agent'
export const CALLER_CWD_HEADER = 'X-Weekly-Reporter-Cwd'
