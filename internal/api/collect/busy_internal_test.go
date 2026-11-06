package collect

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/db/dbtest"
)

// 本文件是包内测试：只为了直接占用 source-operation 锁，验证两条路由的 409
// SOURCE_BUSY 映射（外部包拿不到包级锁）。vitest 侧对应 case 通过 mock 注入 busy，
// Go 侧用真实锁槽位表达同一状态。

func seedLocalSource(t *testing.T, sqlDB *sql.DB, repoPath string) int64 {
	t.Helper()

	res, err := sqlDB.Exec(
		`INSERT INTO collect_sources (type, name, config, enabled, status, project_scope, created_at, updated_at)
		 VALUES ('git-local', '本地仓库', ?, 1, 'enabled', 'personal', 1, 1)`,
		`{"owner":`+strconv.Quote(repoPath)+`,"authorEmails":["fixture@example.com"]}`,
	)
	if err != nil {
		t.Fatalf("seed source: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestGitLocalFetchReturnsConflictWhenSourceIsBusy(t *testing.T) {
	sqlDB := dbtest.New(t)
	queries := db.New(sqlDB)

	id := seedLocalSource(t, sqlDB, filepath.Join(t.TempDir(), "repo"))
	if !acquireSourceOperation(id) {
		t.Fatal("could not acquire lock")
	}
	defer releaseSourceOperation(id)

	handler := gitLocalFetchHandler(Deps{Queries: queries})
	req := httptest.NewRequest(http.MethodPost, "/api/collect/git-local/fetch",
		strings.NewReader(`{"sourceId":`+strconv.FormatInt(id, 10)+`}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"SOURCE_BUSY"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestGitRemoteSyncReturnsConflictWhenSourceIsBusy(t *testing.T) {
	sqlDB := dbtest.New(t)
	queries := db.New(sqlDB)

	id := seedLocalSource(t, sqlDB, filepath.Join(t.TempDir(), "repo"))
	if !acquireSourceOperation(id) {
		t.Fatal("could not acquire lock")
	}
	defer releaseSourceOperation(id)

	handler := gitRemoteSyncHandler(Deps{Queries: queries})
	req := httptest.NewRequest(http.MethodPost, "/api/collect/git-remote/sync",
		strings.NewReader(`{"sourceId":`+strconv.FormatInt(id, 10)+`}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"SOURCE_BUSY"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// 全量同步遇到忙碌源时也会把 SourceOperationBusyError 传回路由 → 409。
func TestGitRemoteSyncAllSourcesReturnsConflictWhenBusy(t *testing.T) {
	sqlDB := dbtest.New(t)
	queries := db.New(sqlDB)

	id := seedLocalSource(t, sqlDB, filepath.Join(t.TempDir(), "repo"))
	if !acquireSourceOperation(id) {
		t.Fatal("could not acquire lock")
	}
	defer releaseSourceOperation(id)

	handler := gitRemoteSyncHandler(Deps{Queries: queries})
	req := httptest.NewRequest(http.MethodPost, "/api/collect/git-remote/sync", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"SOURCE_BUSY"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
