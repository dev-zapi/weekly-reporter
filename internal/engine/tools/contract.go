// Package tools 移植 src/lib/generation 的两个历史查询工具与它们的契约
// （report-list-tool.ts / report-content-tool.ts / report-list-contract.ts /
// report-content-contract.ts，ticket #108）。
//
// 为什么单独成包而不是直接落进 internal/engine：ADR-0027 把这两个查询工具定为
// 引擎的前置依赖，引擎循环票（#110）消费本包的产物。独立子包让两个并行施工的
// 分支可以各自新增文件而不会在同一包内撞出重复符号；包路径仍在蓝图 §4 的
// internal/engine/ 之下。
//
// 行为唯一事实源是上述 TypeScript 文件：错误码与文案、appliedFilters 的每个
// 键、item 的键集（含 warning/matches 的出现时机）都逐条对照。JSON 出参用
// MarshalJSON 固化形状，而不是靠 struct tag 的零值省略，因为「items 必须是 []
// 而不是 null」「nextCursor 必须出现且为 null」这两点直接决定 scripted e2e 的断言。
package tools

import "encoding/json"

// 三个工具名。propose_final_report 的入参边界也住在 B6 批次（ADR-0014），但它的
// 执行副作用属于引擎票；这里只移植被 generation-tools.test.ts 覆盖的 schema 语义。
const (
	ReportListToolName         = "query_report_list"
	ReportContentToolName      = "query_report_content"
	ProposeFinalReportToolName = "propose_final_report"
)

// HistoricalReferenceLabel 是两个历史参考边界共用的 label。
const HistoricalReferenceLabel = "历史参考·不可信"

// 工具错误码（与 TS 的联合类型一致）。
const (
	ErrorCodeInvalidQuery   = "INVALID_QUERY"
	ErrorCodeNotAvailable   = "NOT_AVAILABLE"
	ErrorCodeQueryFailed    = "QUERY_FAILED"
	ErrorCodeBudgetExceeded = "TOOL_BUDGET_EXCEEDED"
)

// 两条历史参考边界的固定文案。
const (
	// StaleFinalWarning 是过期终版的提示。
	StaleFinalWarning = "过期终版尚未反映最新周报原稿。"
	// LegacyReportWarning 是旧版周报的提示。
	LegacyReportWarning = "旧版周报没有周报原稿和受众生成记录，仅供个人版历史参考。"
)

// ReferenceBoundary 是出参里序列化的边界对象。
type ReferenceBoundary struct {
	Label     string `json:"label"`
	Statement string `json:"statement"`
}

// ReportListReferenceBoundary 对应 REFERENCE_BOUNDARY。
var ReportListReferenceBoundary = ReferenceBoundary{
	Label:     HistoricalReferenceLabel,
	Statement: "历史周报列表仅供参考，与当前周报原稿严格分离，不能替代或扩充本周事实。",
}

// ReportContentReferenceBoundary 对应 CONTENT_REFERENCE_BOUNDARY。
var ReportContentReferenceBoundary = ReferenceBoundary{
	Label:     HistoricalReferenceLabel,
	Statement: "历史周报正文仅供参考，与当前周报原稿严格分离，不能替代或扩充本周事实。",
}

// ToolError 是 {ok:false} 出参里的 error 对象。
type ToolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// AppliedReportListFilters 是 queryReportListForSession 规范化后的筛选条件。
// 十个键在所有成功出参里都必须出现；可空项为 nil 时序列化成 null。
type AppliedReportListFilters struct {
	Query              *string  `json:"query"`
	Title              *string  `json:"title"`
	StartDate          *string  `json:"startDate"`
	EndDate            *string  `json:"endDate"`
	Statuses           []string `json:"statuses"`
	IncludeLegacy      bool     `json:"includeLegacy"`
	Relation           string   `json:"relation"`
	RelativeToReportID *int64   `json:"relativeToReportId"`
	Cursor             *string  `json:"cursor"`
	Limit              int      `json:"limit"`
}

// ReportListMatch 是单条命中。title 命中只有 field/content；content 命中还带
// 1-based 的行号。
type ReportListMatch struct {
	Field     string `json:"field"`
	Content   string `json:"content"`
	StartLine *int   `json:"startLine,omitempty"`
	EndLine   *int   `json:"endLine,omitempty"`
}

// ReportListItem 是列表项。warning/matches 只在对应条件成立时出现：
// stale 或 legacy 才有 warning（legacy 覆盖 stale），只有 query 筛选才有 matches。
type ReportListItem struct {
	ReportID         int64              `json:"reportId"`
	Title            string             `json:"title"`
	WeekStart        string             `json:"weekStart"`
	WeekEnd          string             `json:"weekEnd"`
	Audience         string             `json:"audience"`
	FinalStatus      string             `json:"finalStatus"`
	IsLegacy         bool               `json:"isLegacy"`
	UpdatedAt        string             `json:"updatedAt"`
	ContentAvailable bool               `json:"contentAvailable"`
	Warning          *string            `json:"warning,omitempty"`
	Matches          *[]ReportListMatch `json:"matches,omitempty"`
}

// ReportListToolResult 是 query_report_list 的冻结出参。成功与失败互斥：
// OK=false 时只有 Error 有意义，OK=true 时其余字段有意义。
type ReportListToolResult struct {
	OK               bool
	Items            []ReportListItem
	NextCursor       *string
	HasMore          bool
	AppliedFilters   AppliedReportListFilters
	MatchesTruncated *bool
	Error            *ToolError
}

// MarshalJSON 固化成功/失败两种形状。
func (r ReportListToolResult) MarshalJSON() ([]byte, error) {
	if !r.OK {
		return json.Marshal(struct {
			OK                bool              `json:"ok"`
			Error             ToolError         `json:"error"`
			ReferenceBoundary ReferenceBoundary `json:"referenceBoundary"`
		}{false, *r.Error, ReportListReferenceBoundary})
	}
	items := r.Items
	if items == nil {
		items = []ReportListItem{}
	}
	return json.Marshal(struct {
		OK                bool                     `json:"ok"`
		Items             []ReportListItem         `json:"items"`
		NextCursor        *string                  `json:"nextCursor"`
		HasMore           bool                     `json:"hasMore"`
		AppliedFilters    AppliedReportListFilters `json:"appliedFilters"`
		MatchesTruncated  *bool                    `json:"matchesTruncated,omitempty"`
		ReferenceBoundary ReferenceBoundary        `json:"referenceBoundary"`
	}{true, items, r.NextCursor, r.HasMore, r.AppliedFilters, r.MatchesTruncated, ReportListReferenceBoundary})
}

// ReportContentIdentity 是正文查询成功时回传的周报身份。
type ReportContentIdentity struct {
	ReportID            int64   `json:"reportId"`
	Title               string  `json:"title"`
	WeekStart           string  `json:"weekStart"`
	WeekEnd             string  `json:"weekEnd"`
	Audience            string  `json:"audience"`
	FinalStatus         string  `json:"finalStatus"`
	IsLegacy            bool    `json:"isLegacy"`
	UpdatedAt           string  `json:"updatedAt"`
	HistoricalReference string  `json:"historicalReference"`
	Warning             *string `json:"warning,omitempty"`
}

// ReportContentMatch 是一段命中的上下文，行号 1-based。
type ReportContentMatch struct {
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Content   string `json:"content"`
}

// ReportContentToolResult 是 query_report_content 的冻结出参：成功命中、
// 成功未找到（found=false）、失败三种形状互斥。
type ReportContentToolResult struct {
	OK              bool
	Found           bool
	ReportID        float64
	Identity        *ReportContentIdentity
	Content         *string
	Query           *string
	TotalChars      *int
	ReturnedChars   *int
	Truncated       bool
	TotalMatches    *int
	ReturnedMatches *int
	Matches         *[]ReportContentMatch
	Error           *ToolError
}

// MarshalJSON 固化三种形状。
func (r ReportContentToolResult) MarshalJSON() ([]byte, error) {
	if !r.OK {
		return json.Marshal(struct {
			OK                bool              `json:"ok"`
			Error             ToolError         `json:"error"`
			ReferenceBoundary ReferenceBoundary `json:"referenceBoundary"`
		}{false, *r.Error, ReportContentReferenceBoundary})
	}
	if !r.Found {
		return json.Marshal(struct {
			OK                bool              `json:"ok"`
			Found             bool              `json:"found"`
			ReportID          float64           `json:"reportId"`
			Truncated         bool              `json:"truncated"`
			ReferenceBoundary ReferenceBoundary `json:"referenceBoundary"`
		}{true, false, r.ReportID, false, ReportContentReferenceBoundary})
	}
	if r.Query != nil {
		matches := []ReportContentMatch{}
		if r.Matches != nil {
			matches = *r.Matches
		}
		return json.Marshal(struct {
			OK                bool                  `json:"ok"`
			Found             bool                  `json:"found"`
			Identity          ReportContentIdentity `json:"identity"`
			Query             string                `json:"query"`
			Matches           []ReportContentMatch  `json:"matches"`
			TotalMatches      int                   `json:"totalMatches"`
			ReturnedMatches   int                   `json:"returnedMatches"`
			Truncated         bool                  `json:"truncated"`
			ReferenceBoundary ReferenceBoundary     `json:"referenceBoundary"`
		}{true, true, *r.Identity, *r.Query, matches, *r.TotalMatches, *r.ReturnedMatches, r.Truncated, ReportContentReferenceBoundary})
	}
	return json.Marshal(struct {
		OK                bool                  `json:"ok"`
		Found             bool                  `json:"found"`
		Identity          ReportContentIdentity `json:"identity"`
		Content           string                `json:"content"`
		Truncated         bool                  `json:"truncated"`
		ReturnedChars     int                   `json:"returnedChars"`
		TotalChars        int                   `json:"totalChars"`
		ReferenceBoundary ReferenceBoundary     `json:"referenceBoundary"`
	}{true, true, *r.Identity, *r.Content, r.Truncated, *r.ReturnedChars, *r.TotalChars, ReportContentReferenceBoundary})
}

// IsReportListToolResult 复刻 report-list-contract.ts 的类型守卫，供引擎在
// 读取已落库 JSON（map[string]any）时筛选工具结果。
func IsReportListToolResult(value any) bool {
	result, ok := value.(map[string]any)
	if !ok {
		return false
	}
	okValue, ok := result["ok"].(bool)
	if !ok || result["referenceBoundary"] == nil {
		return false
	}
	if !okValue {
		return true
	}
	if _, ok := result["items"].([]any); !ok {
		return false
	}
	return result["appliedFilters"] != nil
}

// IsReportContentToolResult 复刻 report-content-contract.ts 的类型守卫。
func IsReportContentToolResult(value any) bool {
	result, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if _, ok := result["ok"].(bool); !ok {
		return false
	}
	return result["referenceBoundary"] != nil
}
