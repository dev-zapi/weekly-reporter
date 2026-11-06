package collect

import (
	"errors"
	"log"
	"math"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件复刻 src/app/api/collect/git-local/fetch/route.ts。

// gitLocalFetchHandler 复刻 POST /api/collect/git-local/fetch：
//
//	body 的 sourceId 经 Number() 折成数字，必须是正整数（否则 400 INVALID_ID）；
//	采集源不存在 → 404、非本地来源 → 400、其余失败 → 500，均带 code=FETCH_FAILED；
//	同一仓库操作进行中 → 409 SOURCE_BUSY；其它异常 → 500 FETCH_ERROR。
func gitLocalFetchHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSON(r)
		if err != nil {
			// request.json() 抛错落进 route.ts 的 catch → FETCH_ERROR。
			log.Printf("collect: decode fetch body: %v", err)
			respond.Error(w, http.StatusInternalServerError, "仓库 Fetch 失败", "FETCH_ERROR")
			return
		}

		// `Number(body?.sourceId)`：属性缺失/body 为 null 得到 undefined → NaN。
		// 注意与「显式 null」区分：Number(null) 是 0。
		object := objectBody(body)
		rawSourceID, present := object["sourceId"]
		var sourceID float64
		ok := false
		if present {
			sourceID, ok = jsToNumberValue(rawSourceID)
		}
		if !isJSInteger(sourceID, ok) || sourceID <= 0 {
			respond.Error(w, http.StatusBadRequest, "无效的采集源ID", "INVALID_ID")
			return
		}

		result, err := fetchLocalSource(r, deps, sourceID)
		if err != nil {
			if errors.Is(err, errSourceBusy) {
				respond.Error(w, http.StatusConflict, "该仓库正在操作中，请稍后重试", "SOURCE_BUSY")
				return
			}
			log.Printf("collect: fetch local source %v: %v", sourceID, err)
			respond.Error(w, http.StatusInternalServerError, "仓库 Fetch 失败", "FETCH_ERROR")
			return
		}

		if result.Status == "failed" {
			status := http.StatusInternalServerError
			switch *result.Error {
			case "采集源不存在":
				status = http.StatusNotFound
			case "仅支持本地 Git 来源":
				status = http.StatusBadRequest
			}
			respond.JSON(w, status, struct {
				Error  string           `json:"error"`
				Code   string           `json:"code"`
				Result localFetchResult `json:"result"`
			}{Error: *result.Error, Code: "FETCH_FAILED", Result: result})
			return
		}

		respond.JSON(w, http.StatusOK, struct {
			Result localFetchResult `json:"result"`
		}{Result: result})
	}
}

// isJSInteger 复刻 `Number.isInteger(n)`：NaN/Infinity/带小数的值都是 false。
func isJSInteger(value float64, ok bool) bool {
	if !ok {
		return false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return false
	}
	return value == math.Trunc(value)
}
