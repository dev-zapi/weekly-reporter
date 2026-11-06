package collect

import (
	"database/sql"
	"errors"
	"math"
	"net/http"
)

// 本文件复刻 src/lib/collect/git-local-fetch.ts 的 fetchLocalSource。

// fetchLocalSource 复刻 fetchLocalSource：
//   - 采集源不存在 → {sourceId, sourceName: 空串, status:'failed', error:'采集源不存在'}
//   - 非 git-local → {…, status:'failed', error:'仅支持本地 Git 来源'}
//   - 正常路径在每源互斥锁内 fetch origin；Busy 向上抛（路由 409），其余失败变成
//     status:'failed' + error 文案
func fetchLocalSource(r *http.Request, deps Deps, sourceID float64) (localFetchResult, error) {
	ctx := r.Context()

	// drizzle 把 Number 结果绑进整数主键：4.5 这类非整数已被 Number.isInteger 挡掉。
	// 超出 int64 的整数（如 1e21）在 SQLite 里按 REAL 绑定、与 INTEGER 主键比较恒不相等，
	// 所以这里直接当成「查不到」，不把越界的 double 折成 int64（Go 的转换会饱和错位）。
	if sourceID > math.MaxInt64 || sourceID < math.MinInt64 {
		message := "采集源不存在"
		return localFetchResult{SourceID: sourceID, SourceName: "", Status: "failed", Error: &message}, nil
	}
	id := int64(sourceID)

	row, err := deps.Queries.GetCollectSource(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		message := "采集源不存在"
		return localFetchResult{SourceID: sourceID, SourceName: "", Status: "failed", Error: &message}, nil
	}
	if err != nil {
		return localFetchResult{}, err
	}

	source, err := sourceRecordFromGet(row)
	if err != nil {
		return localFetchResult{}, err
	}

	if source.Type != "git-local" {
		message := "仅支持本地 Git 来源"
		return localFetchResult{SourceID: sourceID, SourceName: source.Name, Status: "failed", Error: &message}, nil
	}

	if !acquireSourceOperation(source.ID) {
		return localFetchResult{}, errSourceBusy
	}
	defer releaseSourceOperation(source.ID)

	if err := fetchOrigin(ctx, source.Config.stringValue(keyOwner)); err != nil {
		message := err.Error()
		return localFetchResult{SourceID: float64(source.ID), SourceName: source.Name, Status: "failed", Error: &message}, nil
	}
	return localFetchResult{SourceID: float64(source.ID), SourceName: source.Name, Status: "success"}, nil
}
