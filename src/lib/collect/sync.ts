/**
 * 采集同步的结果类型契约（cutover 后仅类型）。
 *
 * 运行时（git 拉取、适配器、分支游标、source-operation 锁）已由 Go 侧
 * internal/collect 接管（蓝图 B4）；web/（SPA）与既有 client 测试仍以
 * SyncResult 描述 POST /api/collect/sync 的响应形状，两侧逐字段对等。
 */

export interface BranchSyncResult {
  name: string
  status: 'success' | 'failed'
  commitsCount: number
  error?: string
}

export interface SyncResult {
  sourceId: number
  sourceName: string
  status: 'success' | 'failed'
  commitsCount: number
  eventsCount: number
  error?: string
  autoDisabled?: boolean
  /** 部分采集路径失败时的告警信息（整体仍为 success） */
  warnings?: string[]
  /** 各分支同步结果明细（多分支源） */
  branches?: BranchSyncResult[]
}
