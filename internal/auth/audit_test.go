package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// 本文件是 src/lib/auth/audit.test.ts 的 Go 同用例集（ADR-0029）。
//
// 与 guard_test.go 的重合处（401 → unauthorized、成功 → success、审计失败不影响
// 响应）已在中间件测试里覆盖，这里不重复造；本文件补齐 TS 用例集的其余断言面：
// 字段映射（含自报身份头与 null 语义）、recordAudit 的模式门控与惰性数据面，
// 以及"写失败只记日志"这条容错约束。

func newAuditStore(t *testing.T) (*db.Queries, QueriesStore) {
	t.Helper()
	q := db.New(dbtest.New(t))
	return q, QueriesStore{Queries: q}
}

func requestWithHeaders(url, method string, headers map[string]string) *http.Request {
	req := httptest.NewRequest(method, url, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

func onlyAuditRow(t *testing.T, q *db.Queries) db.ApiAuditLog {
	t.Helper()
	rows, err := q.ListAuditLogs(context.Background(), db.ListAuditLogsParams{
		Limit: 10, Offset: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("audit rows = %d, want 1", len(rows))
	}
	return rows[0]
}

func TestRecordAuditMapsRequestFields(t *testing.T) {
	q, store := newAuditStore(t)
	name := "my-agent"

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodPost,
			map[string]string{"User-Agent": "node-fetch/1.0"}),
		http.StatusOK, Result{Mode: ModePAT, PATName: &name})

	row := onlyAuditRow(t, q)
	if row.Method != http.MethodPost {
		t.Fatalf("method = %q", row.Method)
	}
	if row.ApiPath != "/api/events" {
		t.Fatalf("api_path = %q", row.ApiPath)
	}
	if row.Status != http.StatusOK {
		t.Fatalf("status = %d", row.Status)
	}
	if row.UserAgent == nil || *row.UserAgent != "node-fetch/1.0" {
		t.Fatalf("user_agent = %v", row.UserAgent)
	}
	if row.PatName == nil || *row.PatName != "my-agent" {
		t.Fatalf("pat_name = %v", row.PatName)
	}
	if row.Outcome != "success" {
		t.Fatalf("outcome = %q", row.Outcome)
	}
	if row.CreatedAt <= 0 {
		t.Fatalf("created_at = %d, want > 0", row.CreatedAt)
	}
}

func TestRecordAuditMapsCallerIdentityHeaders(t *testing.T) {
	q, store := newAuditStore(t)
	name := "my-agent"

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet,
			map[string]string{
				"X-Weekly-Reporter-Agent": "weekly-reports/claude-code",
				"X-Weekly-Reporter-Cwd":   "/home/user/project",
			}),
		http.StatusOK, Result{Mode: ModePAT, PATName: &name})

	row := onlyAuditRow(t, q)
	if row.AgentIdentity == nil || *row.AgentIdentity != "weekly-reports/claude-code" {
		t.Fatalf("agent_identity = %v", row.AgentIdentity)
	}
	if row.CallerCwd == nil || *row.CallerCwd != "/home/user/project" {
		t.Fatalf("caller_cwd = %v", row.CallerCwd)
	}
}

func TestRecordAuditLeavesAbsentHeadersNull(t *testing.T) {
	q, store := newAuditStore(t)
	name := "my-agent"

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet, nil),
		http.StatusOK, Result{Mode: ModePAT, PATName: &name})

	row := onlyAuditRow(t, q)
	if row.AgentIdentity != nil {
		t.Fatalf("agent_identity = %v, want NULL", *row.AgentIdentity)
	}
	if row.CallerCwd != nil {
		t.Fatalf("caller_cwd = %v, want NULL", *row.CallerCwd)
	}
	if row.UserAgent != nil {
		t.Fatalf("user_agent = %v, want NULL", *row.UserAgent)
	}
}

// 头存在但值为空时 route.ts 存空串（Headers.get 返回 ""），只有头缺失才是 null。
func TestRecordAuditKeepsPresentButEmptyHeadersAsEmpty(t *testing.T) {
	q, store := newAuditStore(t)
	name := "my-agent"

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet,
			map[string]string{
				"User-Agent":              "",
				"X-Weekly-Reporter-Agent": "",
				"X-Weekly-Reporter-Cwd":   "",
			}),
		http.StatusOK, Result{Mode: ModePAT, PATName: &name})

	row := onlyAuditRow(t, q)
	cases := []struct {
		field string
		got   *string
	}{
		{"user_agent", row.UserAgent},
		{"agent_identity", row.AgentIdentity},
		{"caller_cwd", row.CallerCwd},
	}
	for _, tc := range cases {
		if tc.got == nil || *tc.got != "" {
			t.Fatalf("%s = %v, want empty string (not NULL)", tc.field, tc.got)
		}
	}
}

func TestRecordAuditStoresNullPatNameWhenUnidentified(t *testing.T) {
	q, store := newAuditStore(t)

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet, nil),
		http.StatusUnauthorized, Result{Mode: ModePAT})

	row := onlyAuditRow(t, q)
	if row.PatName != nil {
		t.Fatalf("pat_name = %v, want NULL", *row.PatName)
	}
	if row.Outcome != "unauthorized" {
		t.Fatalf("outcome = %q", row.Outcome)
	}
}

func TestRecordAuditMarks401AsUnauthorized(t *testing.T) {
	q, store := newAuditStore(t)
	name := "my-agent"

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet, nil),
		http.StatusUnauthorized, Result{Mode: ModePAT, PATName: &name})

	row := onlyAuditRow(t, q)
	if row.Status != http.StatusUnauthorized || row.Outcome != "unauthorized" {
		t.Fatalf("row = %+v", row)
	}
}

func TestRecordAuditMarksNon401AsSuccess(t *testing.T) {
	q, store := newAuditStore(t)
	name := "my-agent"

	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet, nil),
		http.StatusInternalServerError, Result{Mode: ModePAT, PATName: &name})

	row := onlyAuditRow(t, q)
	if row.Status != http.StatusInternalServerError || row.Outcome != "success" {
		t.Fatalf("row = %+v", row)
	}
}

// 只有 PAT 模式落库；密码 / 关闭模式连 store 都不碰（TS 的惰性 getDatabase）。
func TestRecordAuditIgnoresNonPATModes(t *testing.T) {
	for _, mode := range []Mode{ModePassword, ModeDisabled} {
		t.Run(string(mode), func(t *testing.T) {
			store := &panicStore{t: t}

			RecordAudit(context.Background(), store,
				requestWithHeaders("http://localhost:6868/api/events", http.MethodGet, nil),
				http.StatusOK, Result{Mode: mode})
		})
	}
}

// 审计写失败只记日志，不 panic、不影响响应。
func TestRecordAuditSwallowsWriteErrors(t *testing.T) {
	store := &failingAuditStore{err: errors.New("database is locked")}
	name := "my-agent"

	// 不得 panic。
	RecordAudit(context.Background(), store,
		requestWithHeaders("http://localhost:6868/api/events", http.MethodGet, nil),
		http.StatusOK, Result{Mode: ModePAT, PATName: &name})
}

// panicStore 记录任何数据面调用为失败：非 PAT 模式不得触碰 store。
type panicStore struct{ t *testing.T }

func (s *panicStore) FindPAT(context.Context, string) (PAT, error) {
	s.t.Fatalf("store must not be touched for a non-PAT call")
	return PAT{}, nil
}

func (s *panicStore) TouchPAT(context.Context, int64, int64) error {
	s.t.Fatalf("store must not be touched for a non-PAT call")
	return nil
}

func (s *panicStore) WriteAudit(context.Context, AuditRecord) error {
	s.t.Fatalf("store must not be touched for a non-PAT call")
	return nil
}

type failingAuditStore struct{ err error }

func (s *failingAuditStore) FindPAT(context.Context, string) (PAT, error)  { return PAT{}, nil }
func (s *failingAuditStore) TouchPAT(context.Context, int64, int64) error  { return nil }
func (s *failingAuditStore) WriteAudit(context.Context, AuditRecord) error { return s.err }
