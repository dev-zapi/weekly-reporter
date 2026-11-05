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
	Total int64  `json:"total"`
	Limit *int64 `json:"limit"`
	// offset 是 route.ts 回显的 parseInt double 结果，不是精确整数（≥ 2^53 会
	// 被舍入），所以按 float64 解码。
	Offset *float64 `json:"offset"`
}

// intPtr 让「回显数字」的表驱动用例可以直接写字面量。
func intPtr(v int64) *int64 { return &v }

// assertEcho 断言可空的分页回显字段：want=nil 表示 route.ts 的 NaN → JSON null。
func assertEcho(t *testing.T, field string, got, want *int64) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatalf("%s = %d, want null", field, *got)
		}
		return
	}
	if got == nil {
		t.Fatalf("%s = null, want %d", field, *want)
	}
	if *got != *want {
		t.Fatalf("%s = %d, want %d", field, *got, *want)
	}
}

// assertOffsetEcho 断言 offset 回显。小值（< 2^53）在 double 里是精确的，直接用期望
// 整数比对；≥ 2^53 的舍入由 TestAuditEchoesDoubleRoundedOffset 逐字节钉住。
func assertOffsetEcho(t *testing.T, got *float64, want *int64) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatalf("offset = %v, want null", *got)
		}
		return
	}
	if got == nil {
		t.Fatalf("offset = null, want %d", *want)
	}
	if *got != float64(*want) {
		t.Fatalf("offset = %v, want %d", *got, *want)
	}
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
	assertEcho(t, "limit", resp.Limit, intPtr(50))
	assertOffsetEcho(t, resp.Offset, intPtr(0))
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

	// 新→旧。
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
	assertEcho(t, "limit", resp.Limit, intPtr(2))
	assertOffsetEcho(t, resp.Offset, intPtr(1))
}

// 票内点名：limit clamp 到 [1,200]。
// 非数字（parseInt → NaN）不按默认值处理：route.ts 会丢掉 LIMIT 子句，回显 null
// （见 TestAuditNonNumericPaginationMirrorsRouteTS 的完整矩阵）。
func TestAuditClampsLimit(t *testing.T) {
	cases := []struct {
		path string
		want *int64
	}{
		{"/api/audit?limit=0", intPtr(1)},
		{"/api/audit?limit=-5", intPtr(1)},
		{"/api/audit?limit=1000", intPtr(200)},
		{"/api/audit?limit=200", intPtr(200)},
		{"/api/audit?limit=1", intPtr(1)},
		{"/api/audit?limit=abc", nil},
		// parseInt 语义：前导数字有效，尾部垃圾忽略。
		{"/api/audit?limit=2abc", intPtr(2)},
		{"/api/audit", intPtr(50)},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)

			rec := h.do(tc.path, authPAT.Token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			resp := decodeAudit(t, rec.Body.Bytes())
			assertEcho(t, "limit", resp.Limit, tc.want)
		})
	}
}

// 票内点名：offset 的下界是 0（负值归 0），默认 0。
func TestAuditClampsOffsetToAtLeastZero(t *testing.T) {
	cases := []struct {
		path string
		want *int64
	}{
		{"/api/audit?offset=-1", intPtr(0)},
		{"/api/audit?offset=abc", nil},
		{"/api/audit?offset=3", intPtr(3)},
		{"/api/audit?offset=0", intPtr(0)},
		{"/api/audit?offset=3abc", intPtr(3)},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)

			rec := h.do(tc.path, authPAT.Token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			resp := decodeAudit(t, rec.Body.Bytes())
			assertOffsetEcho(t, resp.Offset, tc.want)
		})
	}
}

// route.ts 回显的是 parseInt 的 double 结果，不是请求里的精确整数：数学值 ≥ 2^53
// 时 parseInt 已舍入到最近的 double，JSON.stringify 再打它的最短往返十进制。
// Go 侧按同一 double 回显，逐字节对齐（期望值由 Node 实测：
// `console.log(JSON.stringify(parseInt(v, 10)))`）。
func TestAuditEchoesDoubleRoundedOffset(t *testing.T) {
	cases := []struct {
		offset string
		want   string // 响应体里的 `"offset":<want>`
	}{
		{"0", "0"},
		{"3", "3"},
		{"9007199254740991", "9007199254740991"}, // 2^53-1，double 仍精确
		{"9007199254740993", "9007199254740992"}, // 2^53+1，舍入到 2^53
		{"4611686018427387905", "4611686018427388000"},
		{"9223372036854775295", "9223372036854775000"}, // 2^63-513，overflow 阈值下方一档
	}
	for _, tc := range cases {
		t.Run(tc.offset, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			h.seedAudit("pat-1", 200, "success", 1_700_000_000_000)

			rec := h.do("/api/audit?offset="+tc.offset, authPAT.Token)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
			}
			if want := `"offset":` + tc.want; !strings.Contains(rec.Body.String(), want) {
				t.Fatalf("body = %s, want %s", rec.Body.String(), want)
			}
		})
	}
}

// 非数字 limit / offset 的可观测行为逐条对照 route.ts（drizzle NaN 副作用）：
// LIMIT/OFFSET 子句消失、回显字段为 null；只有 OFFSET 而无 LIMIT 时 SQL 语法
// 错误 → 500 FETCH_ERROR。票面写明 route.ts 是唯一事实源，蓝图 §2.1 冻结了
// 响应形状与状态码，所以这些不是「可以修好」的空间。
func TestAuditNonNumericPaginationMirrorsRouteTS(t *testing.T) {
	cases := []struct {
		path        string
		wantStatus  int
		wantLimit   *int64
		wantOffset  *int64
		wantRecords int
	}{
		// LIMIT 被丢掉 → 返回全部 5 行（若按默认 50 实现，这一条无法区分，另外
		// 用下面的 60 行用例钉住「子句真的消失」）。
		{"/api/audit?limit=abc", http.StatusOK, nil, intPtr(0), 5},
		{"/api/audit?limit=abc&offset=abc", http.StatusOK, nil, nil, 5},
		{"/api/audit?limit=abc&offset=0", http.StatusOK, nil, intPtr(0), 5},
		{"/api/audit?limit=abc&offset=-5", http.StatusOK, nil, intPtr(0), 5},
		// OFFSET 被丢掉，LIMIT 照常生效。
		{"/api/audit?offset=abc", http.StatusOK, intPtr(50), nil, 5},
		{"/api/audit?offset=abc&limit=2", http.StatusOK, intPtr(2), nil, 2},
		// OFFSET 生效但 LIMIT 缺失 → drizzle 拼出 `... offset 1` → 语法错误 → 500。
		{"/api/audit?limit=abc&offset=1", http.StatusInternalServerError, nil, nil, 0},
		{"/api/audit?limit=abc&offset=3abc", http.StatusInternalServerError, nil, nil, 0},
		// offset 的数学值 ≥ 2^63-512 时 parseInt 的结果是 2^63，drizzle 按 REAL 绑定
		// → datatype mismatch → 同一条 500 路径。
		{"/api/audit?offset=99999999999999999999", http.StatusInternalServerError, nil, nil, 0},
		{"/api/audit?offset=9223372036854775807", http.StatusInternalServerError, nil, nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			h := newHarness(t)
			authPAT := h.createPAT("auth-pat")
			for i := 0; i < 5; i++ {
				h.seedAudit("pat-1", 200, "success", int64(1_700_000_000_000+i))
			}

			rec := h.do(tc.path, authPAT.Token)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus == http.StatusInternalServerError {
				if !strings.Contains(rec.Body.String(), `"code":"FETCH_ERROR"`) {
					t.Fatalf("body = %s, want FETCH_ERROR", rec.Body.String())
				}
				return
			}
			resp := decodeAudit(t, rec.Body.Bytes())
			if len(resp.Records) != tc.wantRecords {
				t.Fatalf("records = %d, want %d", len(resp.Records), tc.wantRecords)
			}
			assertEcho(t, "limit", resp.Limit, tc.wantLimit)
			assertOffsetEcho(t, resp.Offset, tc.wantOffset)
		})
	}
}

// NaN limit 必须真的丢掉 LIMIT 子句（而不是退回默认 50）：60 行数据下返回 60 行。
func TestAuditNonNumericLimitDropsLimitClause(t *testing.T) {
	h := newHarness(t)
	authPAT := h.createPAT("auth-pat")
	for i := 0; i < 60; i++ {
		h.seedAudit("pat-1", 200, "success", int64(1_700_000_000_000+i))
	}

	rec := h.do("/api/audit?limit=abc", authPAT.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	resp := decodeAudit(t, rec.Body.Bytes())
	if len(resp.Records) != 60 {
		t.Fatalf("records = %d, want 60 (LIMIT clause must be dropped)", len(resp.Records))
	}
	if resp.Total != 60 {
		t.Fatalf("total = %d, want 60", resp.Total)
	}
	assertEcho(t, "limit", resp.Limit, nil)
	assertOffsetEcho(t, resp.Offset, intPtr(0))

	// 默认路径仍然只取 50 行——两条路径必须真的不同。
	def := h.do("/api/audit", authPAT.Token)
	if got := len(decodeAudit(t, def.Body.Bytes()).Records); got != 50 {
		t.Fatalf("default records = %d, want 50", got)
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
