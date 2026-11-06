package collect

import (
	"errors"
	"log"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsparse"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件复刻 src/app/api/collect/git-remote/sync/route.ts。

// gitRemoteSyncHandler 复刻 POST /api/collect/git-remote/sync：
//
//	带 sourceId（truthy）→ 单源同步；parseInt 得到 NaN → 400 INVALID_ID；
//	单源失败 → 500 SYNC_FAILED（带 result）；成功 → 200 {result}。
//	不带 sourceId → 全量同步；有失败项 → 500 PARTIAL_SYNC_FAILED（带 results/failedCount）；
//	全部成功 → 200 {results}。
//	Busy → 409 SOURCE_BUSY；其它异常 → 500 SYNC_ERROR。
func gitRemoteSyncHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSON(r)
		if err != nil {
			log.Printf("collect: decode sync body: %v", err)
			respond.Error(w, http.StatusInternalServerError, "同步失败", "SYNC_ERROR")
			return
		}

		// `const { sourceId, resync } = body` 对 null/undefined 抛 TypeError（catch →
		// SYNC_ERROR）；对数字/字符串/数组/对象等其它值都只是取不到属性。
		if body == nil {
			respond.Error(w, http.StatusInternalServerError, "同步失败", "SYNC_ERROR")
			return
		}

		object := objectBody(body)
		rawSourceID, present := object["sourceId"]
		resync := truthyJSON(object["resync"])

		// `if (sourceId)`：缺省、null、0、空串、false 都走全量分支。
		if present && truthyJSON(rawSourceID) {
			// `parseInt(sourceId)` 不传 radix：先把值 ToString，再解析。
			sourceID, ok := jsparse.ParseInt(jsToString(rawSourceID))
			if !ok {
				respond.Error(w, http.StatusBadRequest, "无效的采集源ID", "INVALID_ID")
				return
			}

			result, err := syncSource(r.Context(), deps.Queries, sourceID, resync)
			if err != nil {
				if errors.Is(err, errSourceBusy) {
					respond.Error(w, http.StatusConflict, "该仓库正在操作中，请稍后重试", "SOURCE_BUSY")
					return
				}
				log.Printf("collect: sync source %d: %v", sourceID, err)
				respond.Error(w, http.StatusInternalServerError, "同步失败", "SYNC_ERROR")
				return
			}

			if result.Status == "failed" {
				respond.JSON(w, http.StatusInternalServerError, struct {
					Error  string     `json:"error"`
					Code   string     `json:"code"`
					Result syncResult `json:"result"`
				}{Error: *result.Error, Code: "SYNC_FAILED", Result: result})
				return
			}

			respond.JSON(w, http.StatusOK, struct {
				Result syncResult `json:"result"`
			}{Result: result})
			return
		}

		results, err := syncAllSources(r.Context(), deps.Queries, resync)
		if err != nil {
			if errors.Is(err, errSourceBusy) {
				respond.Error(w, http.StatusConflict, "该仓库正在操作中，请稍后重试", "SOURCE_BUSY")
				return
			}
			log.Printf("collect: sync all sources: %v", err)
			respond.Error(w, http.StatusInternalServerError, "同步失败", "SYNC_ERROR")
			return
		}

		failedCount := 0
		for _, result := range results {
			if result.Status == "failed" {
				failedCount++
			}
		}
		if failedCount > 0 {
			respond.JSON(w, http.StatusInternalServerError, struct {
				Error       string       `json:"error"`
				Code        string       `json:"code"`
				Results     []syncResult `json:"results"`
				FailedCount int          `json:"failedCount"`
			}{Error: "部分采集源同步失败", Code: "PARTIAL_SYNC_FAILED", Results: results, FailedCount: failedCount})
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Results []syncResult `json:"results"`
		}{Results: results})
	}
}
