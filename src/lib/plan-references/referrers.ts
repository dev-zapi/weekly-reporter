/**
 * 计划条目「引用事件」的类型契约（cutover 后仅类型）。
 *
 * 运行时（按 planItemId 联查引用事件）已由 Go 侧接管（蓝图 B3）；
 * web/（SPA）的删除确认弹窗仍以 PlanReferrerEvent 描述
 * GET /api/plans/:id/items/:itemId/referrers 的响应元素形状。
 */

export interface PlanReferrerEvent {
  id: number
  content: string
  eventTime: Date
}
