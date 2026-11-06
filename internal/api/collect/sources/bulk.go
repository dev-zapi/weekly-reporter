package sources

import (
	"encoding/json"
	"net/http"

	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
)

// 本文件复刻两个 bulk 端点：bulk-delete 与 bulk-update-scope。
//
// 两者都从 `const { ids } = body` 取数组：body 为 null 时解构抛 TypeError → 500，
// 其余非对象/缺 ids/ids 非数组/空数组 → 400 INVALID_IDS。

// bulkIDs 从 body 里取 ids 并校验形状。ok=false 时已经写过响应。
// decodeErr 表示 body 需要按 500 处理（null 的解构异常）。
func bulkIDs(w http.ResponseWriter, body any, invalidMessage, serverErrorCode string) ([]any, bool) {
	if body == nil {
		logAndError(w, invalidMessage, serverErrorCode)
		return nil, false
	}
	object, _ := jsObject(body)
	value, present := object["ids"]
	ids, isArray := value.([]any)
	if !present || !isArray || len(ids) == 0 {
		respond.Error(w, http.StatusBadRequest, invalidMessage, "INVALID_IDS")
		return nil, false
	}
	for _, id := range ids {
		switch id.(type) {
		case nil, float64, string:
			// better-sqlite3 只接受 number/string/bigint/buffer/null。
		default:
			logAndError(w, invalidMessage, serverErrorCode)
			return nil, false
		}
	}
	return ids, true
}

// idsJSON 把 ids 序列化成 json_each 参数。float64 的 JSON 表示与 JS 一致
// （整数不带小数点、超大值走指数形式）。
func idsJSON(ids []any) (string, error) {
	encoded, err := json.Marshal(ids)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// bulkDeleteHandler 复刻 POST /api/collect/sources/bulk-delete。
func bulkDeleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSONBody(r)
		if err != nil {
			logAndError(w, "批量删除采集源失败", "DELETE_ERROR")
			return
		}
		ids, ok := bulkIDs(w, body, "请选择要删除的采集源", "DELETE_ERROR")
		if !ok {
			return
		}
		payload, err := idsJSON(ids)
		if err != nil {
			logAndError(w, "批量删除采集源失败", "DELETE_ERROR")
			return
		}
		deleted, err := deps.Queries.DeleteCollectSourcesByIDs(r.Context(), payload)
		if err != nil {
			logAndError(w, "批量删除采集源失败", "DELETE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			Success      bool  `json:"success"`
			DeletedCount int64 `json:"deletedCount"`
		}{Success: true, DeletedCount: deleted})
	}
}

// bulkUpdateScopeHandler 复刻 POST /api/collect/sources/bulk-update-scope。
func bulkUpdateScopeHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := decodeJSONBody(r)
		if err != nil {
			logAndError(w, "批量更新项目类型失败", "UPDATE_ERROR")
			return
		}
		ids, ok := bulkIDs(w, body, "请选择要更新的采集源", "UPDATE_ERROR")
		if !ok {
			return
		}

		object, _ := jsObject(body)
		projectScope, _ := object["projectScope"].(string)
		if projectScope != "work" && projectScope != "personal" {
			respond.Error(w, http.StatusBadRequest, "项目类型必须是 work 或 personal", "INVALID_SCOPE")
			return
		}

		payload, err := idsJSON(ids)
		if err != nil {
			logAndError(w, "批量更新项目类型失败", "UPDATE_ERROR")
			return
		}
		updated, err := deps.Queries.UpdateCollectSourcesProjectScope(r.Context(), payload, projectScope, currentUnix())
		if err != nil {
			logAndError(w, "批量更新项目类型失败", "UPDATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			Success      bool  `json:"success"`
			UpdatedCount int64 `json:"updatedCount"`
		}{Success: true, UpdatedCount: updated})
	}
}
