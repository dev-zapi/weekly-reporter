// Package reports 移植 src/lib/reports/ 下的 server-only 模块：报告原稿生成
// （source-draft.ts）与报告读写服务（service.ts）。B6 的报告路由与引擎票共用
// 这些语义，所以放在路由包之外，与 internal/template、internal/officialtemplates
// 同一思路。
//
// 域语言照 CONTEXT.md：「原稿」(source draft) 是按受众从本周事件确定性生成的
// 纯列表，不含 AI 生成的段落或模板占位符；「终版」(final) 才是 AI 或用户写的
// Markdown。两者的关系见 ADR-0021。
package reports

import (
	"sort"
	"strings"

	"github.com/dev-zapi/weekly-reporter/internal/template"
)

// EmptySourceDraft 是没有任何事件时的原稿（EMPTY_SOURCE_DRAFT）。
const EmptySourceDraft = "- No events this week"

// legacyEmptySourceDraft 是历史部署里写进库中的中文空原稿，读取时要当作空。
const legacyEmptySourceDraft = "- 本周暂无事件"

// IsEmptySourceDraft 复刻 isEmptySourceDraft：两种「空原稿」字面量都算空。
func IsEmptySourceDraft(value string) bool {
	return value == EmptySourceDraft || value == legacyEmptySourceDraft
}

// gitSources 对应 source-draft.ts 的 GIT_SOURCES：命中集合或 `git-` 前缀都算
// git 事件；两者都要有 metadata.repo 才进「仓库分组」。
var gitSources = map[string]struct{}{
	"git-local":         {},
	"github":            {},
	"gitlab":            {},
	"git-remote-github": {},
	"git-remote-gitlab": {},
	"git-remote-gitee":  {},
}

// DraftEvent 是 buildSourceDraft / classifyEventForVariants 的输入元素。
//
// 它同时承载 raw_events 行与 report_event_snapshots 行：TS 用
// `'leadershipIncluded' in event` 区分（快照自带分类结果，原始事件要靠
// sourceScopes 现算），Go 侧用 Snapshot=true 表达同一件事。
type DraftEvent struct {
	// ID 对应 raw.id；raw_event_id 与 id 都在快照映射里用过（见 SnapshotToDraftEvents）。
	ID *int64
	// EventTime 是 Unix 秒（drizzle timestamp 列的存储单位）。
	EventTime int64
	Source    string
	Content   string
	// SourceID 是 metadata.sourceId；SourceIDPresent 区分「键不存在 / 值是 null」
	// 与「键在但不是数字」——TS 里前者归手动组（`sourceId == null`），后者是
	// `sourceId != null` 但 Map.get 不命中，归其他组。
	SourceID        *int64
	SourceIDPresent bool
	// Repo 是 metadata.repo（空串表示没有）。
	Repo string
	// Snapshot=true 表示这一行来自 report_event_snapshots：分类字段直接可信。
	Snapshot           bool
	ProjectScope       *template.ProjectScope
	LeadershipIncluded bool
	PersonalIncluded   bool
}

// IsGitEvent 复刻 isGitEvent：命中 GIT_SOURCES 或以 `git-` 开头。
func IsGitEvent(event DraftEvent) bool {
	if _, ok := gitSources[event.Source]; ok {
		return true
	}
	return strings.HasPrefix(event.Source, "git-")
}

// snapshotOriginGroup 复刻 getSnapshotOriginGroup：快照行按已存的 projectScope
// 判组，没有 sourceId 的算手动。
func snapshotOriginGroup(event DraftEvent) template.OriginGroup {
	if !event.SourceIDPresent {
		return template.GroupManual
	}
	if event.ProjectScope != nil {
		switch *event.ProjectScope {
		case template.ScopeWork:
			return template.GroupWork
		case template.ScopePersonal:
			return template.GroupPersonal
		}
	}
	return template.GroupOther
}

// toDraftEvents 复刻 toDraftEvents：把输入行补齐成带分类的 DraftEvent。
//
// 原始事件（非快照）的分支与 TS 逐条对齐：
//   - scope 只在有 sourceId 时才查映射（查不到是 null，不是 personal）；
//   - leadershipIncluded = 无 sourceId 或 scope === 'work'；
//   - personalIncluded 恒 true。
func toDraftEvents(events []DraftEvent, sourceScopes map[int64]template.ProjectScope) []DraftEvent {
	drafts := make([]DraftEvent, 0, len(events))
	for _, event := range events {
		draft := event
		if !event.Snapshot {
			var scope *template.ProjectScope
			if event.SourceIDPresent && event.SourceID != nil {
				if value, ok := sourceScopes[*event.SourceID]; ok {
					scope = &value
				}
			}
			draft.ProjectScope = scope
			draft.LeadershipIncluded = !event.SourceIDPresent || (scope != nil && *scope == template.ScopeWork)
			draft.PersonalIncluded = true
		}
		drafts = append(drafts, draft)
	}
	return drafts
}

// includedIn 复刻 isIncluded：个人版只排除显式 false，领导版要求显式 true。
func includedIn(event DraftEvent, variant string) bool {
	if variant == "personal" {
		return event.PersonalIncluded
	}
	return event.LeadershipIncluded
}

// BuildSourceDraft 复刻 buildSourceDraft：确定性原稿，只含事件列表。
//
// 结构照 TS：
//  1. 按受众过滤；
//  2. 分成「git 且有 repo」与「其余」两组；
//  3. git 组按 repo 聚合并按事件时间倒序；
//  4. 顶层条目按 (rank, -time) 排序，rank = 组内最小 ORIGIN_GROUP_RANK；
//  5. 有 repo 的条目输出 `- **repo**` + 两空格缩进的子项。
func BuildSourceDraft(events []DraftEvent, variant string, sourceScopes map[int64]template.ProjectScope) string {
	drafts := toDraftEvents(events, sourceScopes)
	selected := make([]DraftEvent, 0, len(drafts))
	for _, event := range drafts {
		if includedIn(event, variant) {
			selected = append(selected, event)
		}
	}
	if len(selected) == 0 {
		return EmptySourceDraft
	}

	repoOrder := make([]string, 0, len(selected))
	repoGroups := make(map[string][]DraftEvent)
	nonGit := make([]DraftEvent, 0, len(selected))
	for _, event := range selected {
		if IsGitEvent(event) && event.Repo != "" {
			if _, seen := repoGroups[event.Repo]; !seen {
				repoOrder = append(repoOrder, event.Repo)
			}
			repoGroups[event.Repo] = append(repoGroups[event.Repo], event)
			continue
		}
		nonGit = append(nonGit, event)
	}

	// group.sort((a, b) => b.eventTime.getTime() - a.eventTime.getTime())：
	// 稳定排序，相等时保持插入顺序（与 V8 的 Array#sort 一致）。
	for _, group := range repoGroups {
		stableSortByEventTimeDesc(group)
	}

	type topLevelItem struct {
		rank   int
		time   int64
		repo   string
		events []DraftEvent
		event  *DraftEvent
	}

	items := make([]topLevelItem, 0, len(repoGroups)+len(nonGit))
	for _, repo := range repoOrder {
		group := repoGroups[repo]
		rank := template.OriginGroupRank[snapshotOriginGroup(group[0])]
		time := group[0].EventTime
		for _, event := range group[1:] {
			if r := template.OriginGroupRank[snapshotOriginGroup(event)]; r < rank {
				rank = r
			}
			if event.EventTime > time {
				time = event.EventTime
			}
		}
		items = append(items, topLevelItem{rank: rank, time: time, repo: repo, events: group})
	}
	for index := range nonGit {
		event := nonGit[index]
		items = append(items, topLevelItem{
			rank:  template.OriginGroupRank[snapshotOriginGroup(event)],
			time:  event.EventTime,
			event: &event,
		})
	}

	// items.sort((a, b) => a.rank - b.rank || b.time - a.time)：V8 的 Array#sort
	// 是稳定排序，rank 与 time 都相等时保持构造顺序。
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].rank != items[j].rank {
			return items[i].rank < items[j].rank
		}
		return items[i].time > items[j].time
	})

	lines := make([]string, 0, len(items))
	for _, item := range items {
		if item.repo != "" && item.events != nil {
			lines = append(lines, "- **"+item.repo+"**")
			for _, event := range item.events {
				lines = append(lines, "  - "+event.Content)
			}
			continue
		}
		if item.event != nil {
			lines = append(lines, "- "+item.event.Content)
		}
	}
	if len(lines) == 0 {
		return EmptySourceDraft
	}
	return strings.Join(lines, "\n")
}

// stableSortByEventTimeDesc 是插入排序：组内元素极少（单仓库的一周提交），
// 稳定且无分配。
func stableSortByEventTimeDesc(group []DraftEvent) {
	for i := 1; i < len(group); i++ {
		current := group[i]
		j := i - 1
		for j >= 0 && group[j].EventTime < current.EventTime {
			group[j+1] = group[j]
			j--
		}
		group[j+1] = current
	}
}

// SourceFacts 是 metadata.sourceId 的两个事实：值（可能为 nil）与是否非 null。
type SourceFacts struct {
	ID      *int64
	Present bool
}

// Classification 是 classifyEventForVariants 的结果。
type Classification struct {
	OriginGroup        template.OriginGroup
	ProjectScope       *template.ProjectScope
	LeadershipIncluded bool
	PersonalIncluded   bool
}

// ClassifyEventForVariants 复刻 classifyEventForVariants：创建报告时把每个原始
// 事件的分类结果固化进 report_event_snapshots。
func ClassifyEventForVariants(source SourceFacts, sourceScopes map[int64]template.ProjectScope) Classification {
	group := template.GroupManual
	if source.Present {
		group = template.GroupOther
		if source.ID != nil {
			group = template.GetOriginGroup(source.ID, sourceScopes)
		}
	}
	var scope *template.ProjectScope
	if group == template.GroupWork || group == template.GroupPersonal {
		value := template.ProjectScope(group)
		scope = &value
	}
	return Classification{
		OriginGroup:        group,
		ProjectScope:       scope,
		LeadershipIncluded: group == template.GroupManual || group == template.GroupWork,
		PersonalIncluded:   true,
	}
}

// AuditanceVariants 是 AUDIENCE_VARIANTS 的顺序（领导版在前）。
var AudienceVariants = []string{"leadership", "personal"}

// SnapshotDraftEvent 是 snapshotToDraftEvents 的一行：快照映射回原稿输入。
type SnapshotDraftEvent struct {
	// ID 是 `snapshot.rawEventId ?? snapshot.id`。
	ID                 int64
	EventTime          int64
	Source             string
	Content            string
	ProjectScope       *template.ProjectScope
	LeadershipIncluded bool
	PersonalIncluded   bool
}

// SnapshotToDraftEvents 复刻 snapshotToDraftEvents：raw_event_id 为空时回退到
// 快照自己的 id。
func SnapshotToDraftEvents(snapshots []SnapshotDraftEvent) []DraftEvent {
	events := make([]DraftEvent, 0, len(snapshots))
	for _, snapshot := range snapshots {
		id := snapshot.ID
		events = append(events, DraftEvent{
			ID:                 &id,
			EventTime:          snapshot.EventTime,
			Source:             snapshot.Source,
			Content:            snapshot.Content,
			Snapshot:           true,
			SourceIDPresent:    true,
			ProjectScope:       snapshot.ProjectScope,
			LeadershipIncluded: snapshot.LeadershipIncluded,
			PersonalIncluded:   snapshot.PersonalIncluded,
		})
	}
	return events
}

// SliceUTF16 复刻 `String.prototype.slice(0, limit)` 的截断行为：边界按 UTF-16
// 码元计算，增补平面字符不会在中间被劈开（码点整体保留）。
//
// 放在 reports 包而不是 jsstr：B6 的引擎票也在建同一组 utf16 helper（ADR-0027），
// 两处都写 jsstr 会在集成分支撞名；这里只服务报告域的两个截断点。
func SliceUTF16(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	count := 0
	for index, r := range value {
		width := 1
		if r > 0xffff {
			width = 2
		}
		if count+width > limit {
			return value[:index]
		}
		count += width
	}
	return value
}
