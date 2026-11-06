package tools

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// 测试夹具对应 e2e/report-list-tool.spec.ts 的 seedQueryFixture：同一组周报
// （上一周期 / 同受众历史 / 跨受众 / 超长正文 / 未采用 current / stale /
// 无变体旧版 / none / 未采用预览）与同一组断言形状。
//
// 那个 fixture 通过 POST /api/e2e/fixtures 造数（E2E_FIXTURES=1 门控），这里
// 直接写库：本包不挂路由，e2e fixtures 路由属于票 #111。

type fixture struct {
	t   *testing.T
	sql *sql.DB
	q   *db.Queries

	// 会话所在周报（target）以及它固定的受众。
	targetReportID int64
	sessionID      int64
	audience       string

	adjacentReportID      int64
	sameAudienceReportID  int64
	crossAudienceReportID int64
	currentLegacyReportID int64
	staleReportID         int64
	legacyReportID        int64
	longReportID          int64
	noneReportID          int64
	unacceptedReportID    int64
}

// 固定时间戳：断言会比对 updatedAt 的 wire 形状。
const fixtureUnix = int64(1_800_000_000)

// newFixture 复刻 e2e fixture 的 standard 模式造数。
func newFixture(t *testing.T, audience string) *fixture {
	t.Helper()
	sqlDB := dbtest.New(t)
	f := &fixture{t: t, sql: sqlDB, q: db.New(sqlDB), audience: audience}

	// target：会话周报，2027-01-11 起一周（e2e 的 scenarioWeek 落在 2027-01）。
	f.targetReportID = f.insertReport("target report", "2027-01-11", "2027-01-17", "# raw source must stay private")

	// createReport 复刻 e2e 的 createReport：一条 reports + 若干 report_variants。
	createReport := func(title, weekStart, weekEnd string, variants []variantSpec) int64 {
		id := f.insertReport(title, weekStart, weekEnd, "# raw source must stay private: "+title)
		for index, variant := range variants {
			accepted := (*int64)(nil)
			if variant.accepted {
				value := id*100 + int64(index) + 1
				accepted = &value
			}
			f.insertVariant(id, variant.audience, variant.finalStatus, variant.finalContent, accepted)
		}
		return id
	}

	// e2e：adjacent = targetStart-7 .. targetStart-1
	f.adjacentReportID = createReport("previous adjacent", "2027-01-04", "2027-01-10", []variantSpec{
		{"personal", "current", strPtr("# previous adjacent personal final"), true},
		{"leadership", "current", strPtr("# previous adjacent leadership final"), true},
	})
	f.sameAudienceReportID = createReport("personal history", "2026-12-21", "2026-12-27", []variantSpec{
		{"personal", "current", strPtr("# searchable personal final"), true},
		{"leadership", "none", nil, false},
	})
	f.crossAudienceReportID = createReport("leadership only", "2026-12-28", "2027-01-03", []variantSpec{
		{"leadership", "current", strPtr("# leadership secret"), true},
		{"personal", "none", nil, false},
	})
	f.longReportID = createReport("long content", "2026-11-09", "2026-11-15", []variantSpec{
		{"personal", "current", strPtr("# long content\n\n" + repeat("x", 41_000)), true},
	})
	f.currentLegacyReportID = createReport("legacy current excluded", "2026-11-23", "2026-11-29", []variantSpec{
		{"personal", "current", strPtr("# legacy current secret"), false},
	})
	f.staleReportID = createReport("stale excluded", "2026-12-14", "2026-12-20", []variantSpec{
		{"personal", "stale", strPtr("# personal stale secret"), true},
		{"leadership", "stale", strPtr("# leadership stale secret"), true},
	})
	f.noneReportID = createReport("none excluded", "2026-12-07", "2026-12-13", []variantSpec{
		{"personal", "none", nil, false},
		{"leadership", "none", nil, false},
	})
	f.unacceptedReportID = createReport("unaccepted excluded", "2026-11-30", "2026-12-06", []variantSpec{
		{"personal", "none", strPtr("# personal unaccepted preview secret"), false},
		{"leadership", "none", strPtr("# leadership unaccepted preview secret"), false},
	})

	// legacy readable：没有任何 report_variants 记录。
	f.legacyReportID = f.insertReport("legacy readable",
		"2026-11-16", "2026-11-22", "# legacy readable content\n\nlegacy grep target")

	f.sessionID = f.insertSession(f.targetReportID, audience)
	return f
}

// variantSpec 是 e2e 夹具里的 variants 元素。
type variantSpec struct {
	audience     string
	finalStatus  string
	finalContent *string
	accepted     bool
}

func strPtr(value string) *string { return &value }

func repeat(value string, count int) string {
	out := make([]byte, 0, len(value)*count)
	for i := 0; i < count; i++ {
		out = append(out, value...)
	}
	return string(out)
}

func (f *fixture) insertReport(title, weekStart, weekEnd, content string) int64 {
	f.t.Helper()
	report, err := f.q.InsertReport(f.t.Context(), db.InsertReportParams{
		Title:     title,
		Content:   content,
		WeekStart: weekStart,
		WeekEnd:   weekEnd,
		CreatedAt: fixtureUnix,
		UpdatedAt: fixtureUnix,
	})
	if err != nil {
		f.t.Fatalf("insert report %q: %v", title, err)
	}
	return report.ID
}

func (f *fixture) insertVariant(reportID int64, audience, finalStatus string, finalContent *string, acceptedProposalID *int64) {
	f.t.Helper()
	_, err := f.sql.ExecContext(f.t.Context(), `
INSERT INTO report_variants (report_id, variant, source_draft, final_content, final_status, accepted_proposal_id, source_revision, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		reportID, audience, "- private source draft for report "+audience, finalContent, finalStatus,
		acceptedProposalID, 1, fixtureUnix, fixtureUnix)
	if err != nil {
		f.t.Fatalf("insert variant: %v", err)
	}
}

func (f *fixture) insertSession(reportID int64, audience string) int64 {
	f.t.Helper()
	result, err := f.sql.ExecContext(f.t.Context(), `
INSERT INTO generation_sessions (report_id, report_variant_id, variant, title, status, source_revision,
  source_draft_snapshot, source_overview, template_id, template_name, template_content,
  ai_style_key, ai_style_label, ai_style_prompt, temperature, system_prompt, tool_rules, created_at, updated_at)
VALUES (?, ?, ?, ?, 'active', 1, 'source', 'overview', 'official-general', 'general', 'content',
  'formal', 'formal', 'prompt', '0.3', 'system', '{}', ?, ?)`,
		reportID, 0, audience, "session", fixtureUnix, fixtureUnix)
	if err != nil {
		f.t.Fatalf("insert session: %v", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		f.t.Fatalf("session id: %v", err)
	}
	return id
}

// decodeJSON 把出参加工成通用结构，便于按 e2e 的断言形状比对（键集、null 与
// [] 的差别都在这里可见）。
func decodeJSON(t *testing.T, value any) map[string]any {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return decoded
}

// mustParseListInput 把 JSON 字面量解析成工具入参，解析失败即测试失败。
func mustParseListInput(t *testing.T, raw string) ReportListInput {
	t.Helper()
	input, err := ParseReportListInput([]byte(raw))
	if err != nil {
		t.Fatalf("parse report list input %s: %v", raw, err)
	}
	return input
}

func mustParseContentInput(t *testing.T, raw string) ReportContentInput {
	t.Helper()
	input, err := ParseReportContentInput([]byte(raw))
	if err != nil {
		t.Fatalf("parse report content input %s: %v", raw, err)
	}
	return input
}

// isoSeconds 是 wire 时间戳的期望值。
func isoSeconds(seconds int64) string {
	return time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}

// base64URLEncode 把任意字节编成 base64url（无 padding），与 Node 的
// Buffer#toString('base64url') 同形。
func base64URLEncode(payload []byte) string {
	return base64.RawURLEncoding.EncodeToString(payload)
}
