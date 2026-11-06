// Package origin 移植 src/lib/template/origin-group.ts：周报原稿生成时事件按
// 来源划分的展示优先级分组。
//
// 这份纯函数住在 `src/lib/template/` 目录下（票 #104「配套移植 src/lib/template/」），
// 当前唯一的消费者是 src/lib/reports/source-draft.ts（B6 报告域）；此处按 TS 的
// 目录结构独立成包，避免把报告域的逻辑塞进模板路由包。
package origin

// OriginGroup 是来源分组：组间固定优先级 manual > work > personal > other。
type OriginGroup string

const (
	// GroupManual 是没有采集源（sourceId 为空）的手动事件。
	GroupManual OriginGroup = "manual"
	// GroupWork 是命中 work scope 的采集事件。
	GroupWork OriginGroup = "work"
	// GroupPersonal 是命中 personal scope 的采集事件。
	GroupPersonal OriginGroup = "personal"
	// GroupOther 是 sourceId 未命中（采集源已删除）的事件。
	GroupOther OriginGroup = "other"
)

// OriginGroupRank 是组间排序权重，逐字移植 ORIGIN_GROUP_RANK。
var OriginGroupRank = map[OriginGroup]int{
	GroupManual:   0,
	GroupWork:     1,
	GroupPersonal: 2,
	GroupOther:    3,
}

// ProjectScope 是采集源的项目归属（src/lib/db/schema.ts 的 ProjectScope）。
type ProjectScope string

const (
	ScopeWork     ProjectScope = "work"
	ScopePersonal ProjectScope = "personal"
)

// GetOriginGroup 复刻 getOriginGroup(event, sourceScopes)：
//   - 无 sourceId → manual；
//   - sourceId 命中 scope 映射 → work / personal；
//   - 未命中 → other。
//
// sourceID 为 nil 对应 TS 的 `metadata?.sourceId == null`（undefined 与 null 都算）。
func GetOriginGroup(sourceID *int64, sourceScopes map[int64]ProjectScope) OriginGroup {
	if sourceID == nil {
		return GroupManual
	}
	switch sourceScopes[*sourceID] {
	case ScopeWork:
		return GroupWork
	case ScopePersonal:
		return GroupPersonal
	}
	return GroupOther
}
