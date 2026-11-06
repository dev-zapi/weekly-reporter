package reports_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 用例集逐条对照 src/app/api/reports/[id]/final/route.test.ts（ADR-0029）。
// TS 侧 mock 了 drizzle 的 findFirst / update / insert / transaction；这里用真实
// SQLite，断言的是同一批可观测结果（状态码 + code + 落库后的响应体）。

// seedFinalFixture 写一行报告 + 一行 leadership 变体（sourceRevision=2）。
func seedFinalFixture(t *testing.T, h *harness) (reportID int64, variantID int64) {
	t.Helper()
	reportID = h.seedReport("报告", "- 完成工作事项", "2024-01-08", "2024-01-14", 1705310800)
	variantID = h.seedVariant(reportID, "leadership", "- 完成工作事项", nil, 2, nil)
	return reportID, variantID
}

func TestSaveFinalRejectsOutdatedSourceRevision(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":1
	}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Code != "SOURCE_REVISION_CONFLICT" {
		t.Fatalf("code = %q, want SOURCE_REVISION_CONFLICT", body.Code)
	}

	// 冲突时不能写库。
	var content *string
	if err := h.sqlDB.QueryRow(`SELECT final_content FROM report_variants WHERE id = ?`, 1).Scan(&content); err != nil {
		t.Fatalf("read variant: %v", err)
	}
	if content != nil {
		t.Fatalf("final_content = %q, want unchanged NULL", *content)
	}
}

func TestSaveFinalSavesAudienceVariantWhenRevisionMatches(t *testing.T) {
	h := newHarness(t)
	reportID, variantID := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		ID           int64   `json:"id"`
		Variant      string  `json:"variant"`
		FinalContent *string `json:"finalContent"`
		FinalStatus  string  `json:"finalStatus"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.ID != variantID || body.Variant != "leadership" {
		t.Fatalf("body = %+v", body)
	}
	if body.FinalContent == nil || *body.FinalContent != "新终版" {
		t.Fatalf("finalContent = %v, want 新终版", body.FinalContent)
	}
	if body.FinalStatus != "current" {
		t.Fatalf("finalStatus = %q, want current", body.FinalStatus)
	}
}

// ADR-0021：直接编辑不写结构完整度契约（历史列保持 NULL）。
func TestSaveFinalDoesNotRewriteStructureContract(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2,
		"templateContent":"明确禁止下周计划章节。"
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var rule *string
	if err := h.sqlDB.QueryRow(`SELECT structure_completeness_rule FROM report_variants WHERE report_id = ?`, reportID).Scan(&rule); err != nil {
		t.Fatalf("read variant: %v", err)
	}
	if rule != nil {
		t.Fatalf("structure_completeness_rule = %q, want NULL", *rule)
	}
}

// legacy 个人版报告（没有变体行）只改 reports.content，不建变体/生成记录。
func TestSaveFinalSavesLegacyPersonalFinalWithoutVariant(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "旧版终稿", "2024-01-08", "2024-01-14", 1705310800)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"personal","content":"已编辑旧版终稿"
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		ID      int64  `json:"id"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if body.Content != "已编辑旧版终稿" {
		t.Fatalf("content = %q", body.Content)
	}

	var variantCount, proposalCount, partCount int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM report_variants`).Scan(&variantCount); err != nil {
		t.Fatal(err)
	}
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_proposals`).Scan(&proposalCount); err != nil {
		t.Fatal(err)
	}
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_message_parts`).Scan(&partCount); err != nil {
		t.Fatal(err)
	}
	if variantCount != 0 || proposalCount != 0 || partCount != 0 {
		t.Fatalf("variants=%d proposals=%d parts=%d, want all 0", variantCount, proposalCount, partCount)
	}
}

// 接受过提案后再次直接编辑：追加一条 application 文本 part 并更新会话基线，
// 计划相关记录不动。
func TestSaveFinalRecordsDirectEditAfterAcceptedSession(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "- 原稿", "2024-01-08", "2024-01-14", 1705310800)

	// 会话 + 已接受的提案（accepted_proposal_id 指向它）。
	sessionID := h.seedSession(reportID, 0, "leadership", "会话", 2, 1700000500)
	proposalID := h.seedProposal(sessionID, "accepted", 2, 1700000400)
	variantID := h.seedVariant(reportID, "leadership", "- 原稿", nil, 2, &proposalID)
	if _, err := h.sqlDB.Exec(`UPDATE generation_sessions SET report_variant_id = ? WHERE id = ?`, variantID, sessionID); err != nil {
		t.Fatalf("link session variant: %v", err)
	}
	// 会话里已有 sequence 12 的消息。
	if _, err := h.sqlDB.Exec(
		`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, created_at)
		 VALUES (?, NULL, 12, 'assistant', 'text', '旧内容', 1700000300)`, sessionID,
	); err != nil {
		t.Fatalf("seed part: %v", err)
	}

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"会话后编辑","sourceRevision":2
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var sequence int64
	var content string
	var data *string
	if err := h.sqlDB.QueryRow(
		`SELECT sequence, content, data FROM generation_message_parts WHERE session_id = ? ORDER BY sequence DESC LIMIT 1`,
		sessionID,
	).Scan(&sequence, &content, &data); err != nil {
		t.Fatalf("read part: %v", err)
	}
	if sequence != 13 {
		t.Fatalf("sequence = %d, want 13", sequence)
	}
	if content != "会话基线后的用户编辑。" {
		t.Fatalf("content = %q", content)
	}
	if data == nil || !contains(*data, `"event":"direct-final-edit"`) || !contains(*data, `"variant":"leadership"`) {
		t.Fatalf("data = %v", data)
	}

	var baseline *string
	if err := h.sqlDB.QueryRow(`SELECT baseline_final_content FROM generation_sessions WHERE id = ?`, sessionID).Scan(&baseline); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if baseline == nil || *baseline != "会话后编辑" {
		t.Fatalf("baseline = %v, want 会话后编辑", baseline)
	}

	// ADR-0021 的两张废弃计划表不写。
	var judgments, overrides int
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_plan_judgments`).Scan(&judgments); err != nil {
		t.Fatal(err)
	}
	if err := h.sqlDB.QueryRow(`SELECT COUNT(*) FROM generation_plan_overrides`).Scan(&overrides); err != nil {
		t.Fatal(err)
	}
	if judgments != 0 || overrides != 0 {
		t.Fatalf("judgments=%d overrides=%d, want 0", judgments, overrides)
	}
}

func TestSaveFinalWritesOfficialTemplateAndStyleKey(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)
	h.seedStyle("formal", "正式汇报", "p", "0.3", true)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2,
		"templateId":"official-tech-dev","aiStyleKey":"formal"
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var templateID, templateName, templateContent, aiStyle *string
	if err := h.sqlDB.QueryRow(
		`SELECT template_id, template_name, template_content, ai_style FROM report_variants WHERE report_id = ?`, reportID,
	).Scan(&templateID, &templateName, &templateContent, &aiStyle); err != nil {
		t.Fatalf("read variant: %v", err)
	}
	if templateID == nil || *templateID != "official-tech-dev" {
		t.Fatalf("templateId = %v", templateID)
	}
	if templateName == nil || *templateName != "技术研发专属周报模板" {
		t.Fatalf("templateName = %v", templateName)
	}
	if templateContent == nil || !contains(*templateContent, "研发周报") {
		t.Fatalf("templateContent = %v", templateContent)
	}
	if aiStyle == nil || *aiStyle != "formal" {
		t.Fatalf("aiStyle = %v", aiStyle)
	}
}

func TestSaveFinalRejectsUnknownTemplate(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2,
		"templateId":"official-nonexistent"
	}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"VALIDATION_ERROR"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSaveFinalRejectsUnknownAIStyle(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2,
		"aiStyleKey":"nonexistent-style"
	}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"VALIDATION_ERROR"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSaveFinalLeavesTemplateAndStyleWhenOmitted(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "- 原稿", "2024-01-08", "2024-01-14", 1705310800)
	if _, err := h.sqlDB.Exec(
		`INSERT INTO report_variants (report_id, variant, source_draft, final_content, final_status, template_id, template_name, template_content, ai_style, source_revision, created_at, updated_at)
		 VALUES (?, 'leadership', '- 原稿', '旧终版', 'current', 'official-general', '通用', '# 模板', 'formal', 2, 1700000000, 1700000100)`,
		reportID,
	); err != nil {
		t.Fatalf("seed variant: %v", err)
	}

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var templateID, aiStyle *string
	if err := h.sqlDB.QueryRow(
		`SELECT template_id, ai_style FROM report_variants WHERE report_id = ?`, reportID,
	).Scan(&templateID, &aiStyle); err != nil {
		t.Fatalf("read variant: %v", err)
	}
	if templateID == nil || *templateID != "official-general" {
		t.Fatalf("templateId = %v, want unchanged official-general", templateID)
	}
	if aiStyle == nil || *aiStyle != "formal" {
		t.Fatalf("aiStyle = %v, want unchanged formal", aiStyle)
	}
}

func TestSaveFinalWritesTemplateSnapshotWithoutStructureRule(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2,
		"templateId":"official-minimal"
	}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	var templateContent, rule *string
	if err := h.sqlDB.QueryRow(
		`SELECT template_content, structure_completeness_rule FROM report_variants WHERE report_id = ?`, reportID,
	).Scan(&templateContent, &rule); err != nil {
		t.Fatalf("read variant: %v", err)
	}
	if templateContent == nil || !contains(*templateContent, "极简") {
		t.Fatalf("templateContent = %v", templateContent)
	}
	if rule != nil {
		t.Fatalf("structureCompletenessRule = %q, want NULL", *rule)
	}
}

func TestSaveFinalRejectsNonStringTemplateID(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"新终版","sourceRevision":2,
		"templateId":123
	}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"INVALID_INPUT"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// 额外的错误形状：非法 id / 缺字段 / 变体不存在 / 非字符串 aiStyleKey。
func TestSaveFinalErrorShapes(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	cases := []struct {
		name   string
		path   string
		body   string
		status int
		code   string
	}{
		{"invalid id", "/api/reports/abc/final", `{"variant":"leadership","content":"x"}`, http.StatusBadRequest, "INVALID_ID"},
		{"missing variant", "/api/reports/" + itoa(reportID) + "/final", `{"content":"x"}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"blank content", "/api/reports/" + itoa(reportID) + "/final", `{"variant":"leadership","content":"   "}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"non string aiStyleKey", "/api/reports/" + itoa(reportID) + "/final", `{"variant":"leadership","content":"x","aiStyleKey":1}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"legacy personal without variant writes report content", "/api/reports/" + itoa(reportID) + "/final", `{"variant":"personal","content":"x","sourceRevision":2}`, http.StatusOK, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.do(http.MethodPut, tc.path, tc.body)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.status, rec.Body.String())
			}
			if tc.code == "" {
				return
			}
			if !contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("body = %s, want code %s", rec.Body.String(), tc.code)
			}
		})
	}
}

// 领导版变体不存在时是 VARIANT_NOT_FOUND（个人版走 legacy 分支）。
func TestSaveFinalLeadershipWithoutVariantIsVariantNotFound(t *testing.T) {
	h := newHarness(t)
	reportID := h.seedReport("报告", "- 原稿", "2024-01-08", "2024-01-14", 1705310800)

	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", `{
		"variant":"leadership","content":"x","sourceRevision":2
	}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), `"code":"VARIANT_NOT_FOUND"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// seedProposal 直接写一行 generation_proposals，返回 id。
func (h *harness) seedProposal(sessionID int64, status string, sourceRevision int64, createdAt int64) int64 {
	h.t.Helper()
	var acceptedAt any
	if status == "accepted" {
		acceptedAt = createdAt
	}
	res, err := h.sqlDB.Exec(
		`INSERT INTO generation_proposals (session_id, turn_id, content, summary, source_revision, status, created_at, accepted_at)
		 VALUES (?, 0, '提案正文', '[]', ?, ?, ?, ?)`,
		sessionID, sourceRevision, status, createdAt, acceptedAt,
	)
	if err != nil {
		h.t.Fatalf("seed proposal: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// 请求体不是合法 JSON / 是 null 时，route.ts 的 catch 都是 500 SAVE_FINAL_ERROR
// 且带 details（诊断字段）。details 是 String(error)：null-body 的 TypeError
// 保留自己的名字，普通错误带 "Error: " 前缀。
func TestSaveFinalMalformedBody(t *testing.T) {
	h := newHarness(t)
	reportID, _ := seedFinalFixture(t, h)

	for _, body := range []string{"not-json", "null"} {
		rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", body)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("body %q: status = %d, want 500 (body %s)", body, rec.Code, rec.Body.String())
		}
		if !contains(rec.Body.String(), `"code":"SAVE_FINAL_ERROR"`) || !contains(rec.Body.String(), `"details":`) {
			t.Fatalf("body %q: response = %s", body, rec.Body.String())
		}
	}

	var response struct {
		Details string `json:"details"`
	}
	rec := h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", "null")
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode null body: %v", err)
	}
	if response.Details != "TypeError: Cannot read properties of null (reading 'variant')" {
		t.Fatalf("null details = %q", response.Details)
	}

	rec = h.do(http.MethodPut, "/api/reports/"+itoa(reportID)+"/final", "not-json")
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode malformed body: %v", err)
	}
	if !strings.HasPrefix(response.Details, "Error: ") {
		t.Fatalf("malformed details = %q, want String(error) prefix", response.Details)
	}
}
