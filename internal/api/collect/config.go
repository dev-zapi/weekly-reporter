package collect

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsstr"
)

// 本文件是 src/lib/collect/{branches,types,sync}.ts 里与本域两条同步路由相关的
// 数据形状与纯函数：采集源配置视图、分支规范化与全分支归属排序。

// sourceConfig 是 collect_sources.config 的 JS 视图。
//
// 保留成 map 而不是结构体的理由：sync.ts 的写路径是
// `{...source.config, branches: updatedBranches}` —— 未知键必须原样带回。用结构体
// 会把 aliases 之类的键静默丢掉，那是对配置的破坏。
//
// 序列化差异（可接受）：JS 的 JSON.stringify 保留对象原有键序，Go 的
// json.Marshal 对 map 按键名排序。config 的消费者都按字段名读取，键序不可观测。
type sourceConfig map[string]any

// parseSourceConfig 复刻 drizzle 的 json mode：JSON.parse（顶层不是对象时按空对象处理）。
func parseSourceConfig(raw []byte) (sourceConfig, error) {
	config := sourceConfig{}
	if len(raw) == 0 {
		return config, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	if object, ok := parsed.(map[string]any); ok {
		return sourceConfig(object), nil
	}
	return config, nil
}

// with 返回把某个键改写后的浅拷贝（复刻 `{...config, key: value}`）。
func (c sourceConfig) with(key string, value any) sourceConfig {
	next := make(sourceConfig, len(c)+1)
	for k, v := range c {
		next[k] = v
	}
	next[key] = value
	return next
}

// stringValue 读一个字符串字段（JS 的 `config.owner`）；缺失或非字符串返回空串。
func (c sourceConfig) stringValue(key string) string {
	if value, ok := c[key].(string); ok {
		return value
	}
	return ""
}

// authorEmails 复刻 `config.authorEmails`，保留原始元素形态以便与
// `authorEmails.includes(email)` 的严格相等语义对齐。
func (c sourceConfig) authorEmails() []any {
	if values, ok := c[keyAuthorEmails].([]any); ok {
		return values
	}
	return nil
}

// hasAuthorEmail 复刻 `source.config?.authorEmails && authorEmails.length > 0`。
func (c sourceConfig) hasAuthorEmail() bool {
	return len(c.authorEmails()) > 0
}

// includesAuthorEmail 复刻 `authorEmails.includes(email)`：严格相等，不做大小写折叠。
func (c sourceConfig) includesAuthorEmail(email string) bool {
	for _, value := range c.authorEmails() {
		if text, ok := value.(string); ok && text == email {
			return true
		}
	}
	return false
}

const (
	keyOwner         = "owner"
	keyRepo          = "repo"
	keyBaseURL       = "baseUrl"
	keyToken         = "token"
	keyAuthorEmails  = "authorEmails"
	keyBranches      = "branches"
	keyBranchCursors = "branchCursors"
	keyPaths         = "paths"
)

// branchCursor 是 config.branchCursors 的一项（ADR-0017 全分支采集游标）。
type branchCursor struct {
	Name           string  `json:"name"`
	LastCommitTime *string `json:"lastCommitTime"`
}

// normalizedBranch 是 normalizeBranches 的输出项：显式分支 + 各自游标。
// JSON 键名与 schema.ts 的 branch 对象一致（写回 config 时不能出现 Go 字段名）。
type normalizedBranch struct {
	Name           string  `json:"name"`
	LastCommitTime *string `json:"lastCommitTime"`
}

// isEmptyBranchConfig 复刻 src/lib/collect/branches.ts 的同名函数：
// 缺失、空数组，或每个元素的名字 trim 后都是空串。
func isEmptyBranchConfig(raw any) bool {
	entries, ok := raw.([]any)
	if !ok {
		// TS 的 `if (!branches) return true` 与 `!Array.isArray(branches) return true`。
		return true
	}
	if len(entries) == 0 {
		return true
	}
	for _, entry := range entries {
		name, ok := branchEntryName(entry)
		if ok && jsstr.Trim(name) != "" {
			return false
		}
	}
	return true
}

// branchEntryName 取分支项的名字：字符串形态直接用它，对象形态取 name 字段。
func branchEntryName(entry any) (string, bool) {
	switch value := entry.(type) {
	case string:
		return value, true
	case map[string]any:
		name, ok := value["name"].(string)
		return name, ok
	}
	return "", false
}

// normalizeBranches 复刻 sync.ts 的 normalizeBranches：兼容旧 string[] 与新
// {name,lastCommitTime}[]；空/非法配置折成单条「无名分支」（= 仓库默认分支）。
func normalizeBranches(raw any) []normalizedBranch {
	entries, ok := raw.([]any)
	if !ok || len(entries) == 0 {
		return []normalizedBranch{{Name: ""}}
	}

	branches := make([]normalizedBranch, 0, len(entries))
	for _, entry := range entries {
		switch value := entry.(type) {
		case string:
			branches = append(branches, normalizedBranch{Name: value})
		case map[string]any:
			name, _ := value["name"].(string)
			branches = append(branches, normalizedBranch{
				Name:           name,
				LastCommitTime: nonEmptyCursor(value["lastCommitTime"]),
			})
		default:
			branches = append(branches, normalizedBranch{Name: ""})
		}
	}
	return branches
}

// nonEmptyCursor 复刻 `x.lastCommitTime || null`：非字符串与空串都折成 nil。
func nonEmptyCursor(value any) *string {
	if text, ok := value.(string); ok && text != "" {
		return &text
	}
	return nil
}

// parseBranchCursors 读 config.branchCursors；非法结构按空列表处理（TS 侧
// `source.config.branchCursors || []` 同样的宽松语义）。
func parseBranchCursors(raw any) []branchCursor {
	entries, ok := raw.([]any)
	if !ok {
		return nil
	}
	cursors := make([]branchCursor, 0, len(entries))
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name, _ := object["name"].(string)
		cursors = append(cursors, branchCursor{Name: name, LastCommitTime: nonEmptyCursor(object["lastCommitTime"])})
	}
	return cursors
}

// orderBranchesForAttribution 复刻 branches.ts：当前分支优先（仅当它在本地 heads
// 里），其余按字母升序，不重复。
func orderBranchesForAttribution(localHeads []string, currentBranch string) []string {
	ordered := make([]string, 0, len(localHeads))
	seen := make(map[string]struct{}, len(localHeads))

	if currentBranch != "" && containsString(localHeads, currentBranch) {
		ordered = append(ordered, currentBranch)
		seen[currentBranch] = struct{}{}
	}

	rest := append([]string(nil), localHeads...)
	// branches.ts 用 `sort((a, b) => a.localeCompare(b))`；Go 的 sort.Strings 是
	// 码点序（ASCII 上等价）。差异只在非 ASCII 键与仅大小写不同的分支名上可见，
	// 克隆一份 ICU collation 不在本票范围内（ticket 只要求 git 执行面移植）。
	sort.Strings(rest)
	for _, name := range rest {
		if _, ok := seen[name]; ok {
			continue
		}
		ordered = append(ordered, name)
		seen[name] = struct{}{}
	}
	return ordered
}

// buildPrunedBranchCursors 复刻 buildPrunedBranchCursors：按当前 heads 重建游标，
// 已删除分支的游标一并清理；本次拉到新 commit 的分支用新的 max committer date。
func buildPrunedBranchCursors(
	localHeads []string,
	maxByBranch map[string]time.Time,
	existing []branchCursor,
) []branchCursor {
	existingByName := make(map[string]*string, len(existing))
	for _, cursor := range existing {
		if _, ok := existingByName[cursor.Name]; ok {
			continue
		}
		existingByName[cursor.Name] = cursor.LastCommitTime
	}

	cursors := make([]branchCursor, 0, len(localHeads))
	for _, name := range localHeads {
		cursor := branchCursor{Name: name}
		if max, ok := maxByBranch[name]; ok {
			value := isoMillisFromTime(max)
			cursor.LastCommitTime = &value
		} else if previous, ok := existingByName[name]; ok {
			cursor.LastCommitTime = previous
		}
		cursors = append(cursors, cursor)
	}
	return cursors
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// eventMetadata 是 raw_events.metadata 的形状（schema.ts 的 RawEventMetadata）。
// url 在本地适配器里恒为空串、sourceId/sourceName 可能缺席，所以按 TS 的
// undefined 语义用 omitempty 表达「不写这个键」。
type eventMetadata struct {
	Sha        string  `json:"sha"`
	URL        string  `json:"url"`
	Repo       string  `json:"repo"`
	Branch     string  `json:"branch"`
	SourceID   *int64  `json:"sourceId,omitempty"`
	SourceName *string `json:"sourceName,omitempty"`
}

// rawEventData 是 normalizeCommit 的输出（types.ts 的 RawEventData）。
type rawEventData struct {
	EventTime time.Time
	Source    string
	Content   string
	Metadata  eventMetadata
	Category  string
}

// gitCommit 是本地 git log 的一行（types.ts 的 GitCommit 子集，本地源不产出 stats）。
type gitCommit struct {
	Sha           string
	Message       string
	AuthorDate    time.Time
	CommitterDate time.Time
	AuthorEmail   string
	AuthorName    string
	// URL 只有远端适配器填（本地 git 没有网页地址，TS 侧写空串）。
	URL string
}

// normalizeLocalCommit 复刻 localGitAdapter.normalizeCommit：eventTime 取 author
// date，content 取 message 首行，category 固定「核心开发」。
func normalizeLocalCommit(commit gitCommit, source, repo, branch string, sourceID int64, sourceName string) rawEventData {
	content := commit.Message
	if index := strings.Index(content, "\n"); index >= 0 {
		content = content[:index]
	}
	return rawEventData{
		EventTime: commit.AuthorDate,
		Source:    source,
		Content:   content,
		Metadata: eventMetadata{
			Sha:        commit.Sha,
			URL:        commit.URL,
			Repo:       repo,
			Branch:     branch,
			SourceID:   &sourceID,
			SourceName: &sourceName,
		},
		Category: "核心开发",
	}
}
