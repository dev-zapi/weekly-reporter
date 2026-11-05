package audit

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 本文件是 src/app/api/audit/route.test.ts 的 Go 同用例集（ADR-0029）：
// 8 个用例逐条对应，另外补票内点名的边界（limit clamp、非法过滤值静默忽略、
// 排序的 createdAt desc, id desc、NaN 默认值路径）。

type auditResponse struct {
	Records []struct {
		ID            int64   `json:"id"`
		CreatedAt     int64   `json:"createdAt"`
		PatName       *string `json:"patName"`
		Method        string  `json:"method"`
		APIPath       string  `json:"apiPath"`
		Status        int64   `json:"status"`
		UserAgent     *string `json:"userAgent"`
		AgentIdentity *string `json:"agentIdentity"`
		CallerCwd     *string `json:"callerCwd"`
		Outcome       string  `json:"outcome"`
	} `json:"records"`
	Total  int64 `json:"total"`
	Limit  int64 `json:"limit"`
	Offset int64 `json:"offset"`
}

func decodeAudit(t *testing.T, body []byte) auditResponse {
	t.Helper()
	var resp auditResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
	return resp
}

func TestAuditReturns401WhenNotAuthenticated(t *testing.T) {
	h := newHarness(t)

	rec := h.do("/api/audit", "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAuditReturnsEmptyArrayWhenNoRecords(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")

	rec := h.do("/api/audit", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// 空记录必须是 []，不能是 null（前端直接 map records）。
	if !strings.Contains(rec.Body.String(), `"records":[]`) {
		t.Fatalf("body = %s, want records:[]", rec.Body.String())
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 0 {
		t.Fatalf("records = %d", len(resp.Records))
	}
	// 本请求自己的审计行在已写库之后才可能出现在下一次查询里；此刻 total 为 0。
	if resp.Total != 0 {
		t.Fatalf("total = %d, want 0", resp.Total)
	}
	if resp.Limit != 50 || resp.Offset != 0 {
		t.Fatalf("limit/offset = %d/%d, want 50/0 defaults", resp.Limit, resp.Offset)
	}
}

func TestAuditReturnsPaginatedRecordsNewestFirst(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)
	h.seedAudit("pat-2", 201, "success", 1_700_000_001_000)

	rec := h.do("/api/audit", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 2 {
		t.Fatalf("records = %d, want 2", len(resp.Records))
	}
	if resp.Total != 2 {
		t.Fatalf("total = %d, want 2", resp.Total)
	}

	// Newest first.
	first, second := resp.Records[0].PatName, resp.Records[1].PatName
	if first == nil || *first != "pat-2" {
		t.Fatalf("records[0].patName = %v, want pat-2", first)
	}
	if second == nil || *second != "pat-1" {
		t.Fatalf("records[1].patName = %v, want pat-1", second)
	}
}

// 同一毫秒的多行必须按 id desc 兜底排序（TS 的 orderBy(desc(createdAt), desc(id))）。
func TestAuditBreaksCreatedAtTiesByIDDesc(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	const sameMillis int64 = 1_700_000_000_000
	h.seedAudit("first", 200, "success", sameMillis)
	h.seedAudit("second", 200, "success", sameMillis)
	h.seedAudit("third", 200, "success", sameMillis)

	rec := h.do("/api/audit", authPAT.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 3 {
		t.Fatalf("records = %d, want 3", len(resp.Records))
	}
	want := []string{"third", "second", "first"}
	for i, name := range want {
		if resp.Records[i].PatName == nil || *resp.Records[i].PatName != name {
			t.Fatalf("records[%d].patName = %v, want %q", i, resp.Records[i].PatName, name)
		}
	}
}

func TestAuditFiltersByPatName(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)
	h.seedAudit("pat-2", 200, "success", 1_700_000_001_000)

	rec := h.do("/api/audit?patName=pat-1", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(resp.Records))
	}
	if resp.Records[0].PatName == nil || *resp.Records[0].PatName != "pat-1" {
		t.Fatalf("records[0].patName = %v", resp.Records[0].PatName)
	}
	// total 必须跟着过滤条件走，否则分页页码会算错。
	if resp.Total != 1 {
		t.Fatalf("total = %d, want 1", resp.Total)
	}
}

func TestAuditFiltersByStatus(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)
	h.seedAudit("pat-1", 401, "unauthorized", 1_700_000_001_000)

	rec := h.do("/api/audit?status=401", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(resp.Records))
	}
	if resp.Records[0].Status != 401 {
		t.Fatalf("records[0].status = %d, want 401", resp.Records[0].Status)
	}
	if resp.Total != 1 {
		t.Fatalf("total = %d, want 1", resp.Total)
	}
}

func TestAuditFiltersByOutcome(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)
	h.seedAudit("pat-1", 401, "unauthorized", 1_700_000_001_000)

	rec := h.do("/api/audit?outcome=unauthorized", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(resp.Records))
	}
	if resp.Records[0].Outcome != "unauthorized" {
		t.Fatalf("records[0].outcome = %q, want unauthorized", resp.Records[0].Outcome)
	}
}

func TestAuditSupportsLimitAndOffset(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	for i := 0; i < 5; i++ {
		h.seedAudit("pat-1", 200, "success", int64(1_700_000_000_000+i))
	}

	rec := h.do("/api/audit?limit=2&offset=1", authPAT.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 2 {
		t.Fatalf("records = %d, want 2", len(resp.Records))
	}
	// total 是过滤后的总数，与 limit/offset 无关。
	if resp.Total != 5 {
		t.Fatalf("total = %d, want 5", resp.Total)
	}
	if resp.Limit != 2 || resp.Offset != 1 {
		t.Fatalf("limit/offset = %d/%d, want 2/1 echoed back", resp.Limit, resp.Offset)
	}
}

// 票内点名：limit clamp 到 [1,200]。
func TestAuditClampsLimit(t *testing.T) {
	cases := map[string]int64{
		"/api/audit?limit=0":    1,
		"/api/audit?limit=-5":   1,
		"/api/audit?limit=1000": 200,
		"/api/audit?limit=200":  200,
		"/api/audit?limit=1":    1,
		// NaN 路径：非数字回落到默认 50。
		"/api/audit?limit=abc": 50,
		// parseInt 语义：前导数字有效，尾部垃圾忽略。
		"/api/audit?limit=2abc": 2,
		"/api/audit":            50,
	}
	for path, want := range cases {
		t.Run(path, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)

			rec := h.do(path, authPAT.Token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			resp := decodeAudit(t, rec.Body.Bytes())
			if resp.Limit != want {
				t.Fatalf("limit = %d, want %d", resp.Limit, want)
			}
		})
	}
}

// 票内点名：offset 的下界是 0（负值归 0），默认 0。
func TestAuditClampsOffsetToAtLeastZero(t *testing.T) {
	cases := map[string]int64{
		"/api/audit?offset=-1":   0,
		"/api/audit?offset=abc":  0,
		"/api/audit?offset=3":    3,
		"/api/audit?offset=0":    0,
		"/api/audit?offset=3abc": 3,
	}
	for path, want := range cases {
		t.Run(path, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)

			rec := h.do(path, authPAT.Token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			resp := decodeAudit(t, rec.Body.Bytes())
			if resp.Offset != want {
				t.Fatalf("offset = %d, want %d", resp.Offset, want)
			}
		})
	}
}

// 票内点名：非法过滤值静默忽略（不 400、不过滤）。
func TestAuditIgnoresInvalidFilterValues(t *testing.T) {
	cases := []string{
		"/api/audit?status=not-a-number",
		"/api/audit?outcome=whatever",
		"/api/audit?patName=",
	}
	for _, path := range cases {
		t.Run(path, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)
			h.seedAudit("pat-2", 401, "unauthorized", 1_700_000_001_000)

			rec := h.do(path, authPAT.Token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			resp := decodeAudit(t, rec.Body.Bytes())
			if len(resp.Records) != 2 || resp.Total != 2 {
				t.Fatalf("records/total = %d/%d, want 2/2 (filter must be ignored)",
					len(resp.Records), resp.Total)
			}
		})
	}
}

// 行字段映射：camelCase 键、可空字段为 null。TS 用例只间接覆盖，这里显式钉住。
func TestAuditMapsRowFields(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	h.seedAudit("pat-1", 201, "success", 1_700_000_000_000)

	rec := h.do("/api/audit", authPAT.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	row := decodeAudit(t, rec.Body.Bytes()).Records[0]

	if row.Method != http.MethodGet || row.APIPath != "/api/events" || row.Status != 201 {
		t.Fatalf("row = %+v", row)
	}
	if row.CreatedAt != 1_700_000_000_000 {
		t.Fatalf("createdAt = %d", row.CreatedAt)
	}
	if row.UserAgent == nil || *row.UserAgent != "node-fetch/1.0" {
		t.Fatalf("userAgent = %v", row.UserAgent)
	}
	if row.AgentIdentity == nil || *row.AgentIdentity != "weekly-reports/claude-code" {
		t.Fatalf("agentIdentity = %v", row.AgentIdentity)
	}
	if row.CallerCwd == nil || *row.CallerCwd != "/tmp/project" {
		t.Fatalf("callerCwd = %v", row.CallerCwd)
	}
}

func TestAuditRecordsAuditForAuditQuery(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")

	rec := h.do("/api/audit", authPAT.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	if got := h.auditRowCount(); got != 1 {
		t.Fatalf("audit rows = %d, want 1", got)
	}
	var patName string
	var status int64
	var outcome string
	if err := h.sqlDB.QueryRow(
		"SELECT pat_name, status, outcome FROM api_audit_log ORDER BY id DESC LIMIT 1",
	).Scan(&patName, &status, &outcome); err != nil {
		t.Fatal(err)
	}
	if patName != "auth-pat" || status != http.StatusOK || outcome != "success" {
		t.Fatalf("audit row = %q/%d/%q", patName, status, outcome)
	}
}
