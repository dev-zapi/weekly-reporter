package sources

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/dev-zapi/weekly-reporter/internal/api/jsjson"
	"github.com/dev-zapi/weekly-reporter/internal/api/respond"
	"github.com/dev-zapi/weekly-reporter/internal/db"
)

// 本文件复刻 `/api/collect/sources/{id}` 的 GET / PUT / PATCH / DELETE。

// currentUnix 是 `new Date()` 落库后的秒级 Unix 时间（drizzle timestamp mode）。
func currentUnix() int64 { return time.Now().Unix() }

// isValidStoredConfig 复刻 drizzle json mode 的读路径校验：config 是 JSON 文本，
// findFirst/findMany 会 JSON.parse，损坏的行让整条请求落进 catch（500）。
func isValidStoredConfig(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	return json.Valid(raw)
}

// getHandler 复刻 GET：非法 id → 400 INVALID_ID，未找到 → 404 NOT_FOUND。
func getHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseIntID(chi.URLParam(r, "id"))
		if !ok {
			respond.Error(w, http.StatusBadRequest, "无效的采集源ID", "INVALID_ID")
			return
		}
		row, err := deps.Queries.GetCollectSource(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "采集源不存在", "NOT_FOUND")
			return
		}
		if err != nil {
			logAndError(w, "获取采集源失败", "FETCH_ERROR")
			return
		}
		item, err := toSourceJSON(row.Record())
		if err != nil {
			logAndError(w, "获取采集源失败", "FETCH_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, item)
	}
}

// putHandler 复刻 PUT：保留 token（表单只会回显 [ENCRYPTED]）→ zod 校验 →
// 别名查重（忽略自己）→ 状态推导 → 分支游标合并 → 全量更新。
func putHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseIntID(chi.URLParam(r, "id"))
		if !ok {
			respond.Error(w, http.StatusBadRequest, "无效的采集源ID", "INVALID_ID")
			return
		}

		existing, err := deps.Queries.GetCollectSource(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "采集源不存在", "NOT_FOUND")
			return
		}
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}

		if !isValidStoredConfig(existing.Config) {
			// drizzle 的 findFirst 会 JSON.parse config；损坏的存量行 → catch → 500。
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		// `const { config } = body` 对 null 抛 TypeError → 500。
		if body == nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}

		normalizedBody := withPreservedToken(body, existing.Config)
		input, issues := validateCollectSource(normalizedBody)
		if len(issues) > 0 {
			respondValidation(w, issues)
			return
		}

		if len(input.Aliases) > 0 {
			existingAliases, err := existingAliases(r, deps.Queries, id)
			if err != nil {
				logAndError(w, "更新采集源失败", "UPDATE_ERROR")
				return
			}
			if duplicates := duplicateAliases(input.Aliases, existingAliases); len(duplicates) > 0 {
				respond.Error(w, http.StatusBadRequest, "别名已被使用: "+joinAliases(duplicates), "DUPLICATE_ALIAS")
				return
			}
		}

		status := sourceStatusFromConfig(input.Config.AuthorEmails, input.Enabled)
		configJSON, err := marshalUpdateConfig(existing.Config, input)
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}

		var enabled *int64
		if input.Enabled != nil {
			enabled = boolPointer(*input.Enabled)
		}
		record, err := deps.Queries.UpdateCollectSource(r.Context(), id, db.CollectSourceWrite{
			Type:         input.Type,
			Name:         input.Name,
			Config:       configJSON,
			Enabled:      enabled,
			Status:       &status,
			ProjectScope: input.ProjectScope,
			UpdatedAt:    currentUnix(),
		})
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		item, err := toSourceJSON(record)
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, item)
	}
}

// withPreservedToken 复刻 PUT 的 token 保留逻辑：
//
//	shouldKeepToken = body.type !== 'git-local' && (!body.config.token || body.config.token === '[ENCRYPTED]')
//	normalizedBody  = shouldKeepToken && existingConfig.token ? {...body, config: {...bodyConfig, token: existingConfig.token}} : body
func withPreservedToken(body any, existingConfig []byte) any {
	object := spreadObject(body)
	bodyConfig, _ := jsObject(object["config"])
	if bodyConfig == nil {
		bodyConfig = map[string]any{}
	}

	bodyType, _ := object["type"].(string)
	tokenValue := bodyConfig["token"]
	shouldKeepToken := bodyType != "git-local" && (!jsTruthy(tokenValue) || tokenValue == "[ENCRYPTED]")
	if !shouldKeepToken {
		return body
	}

	storedToken, ok := storedConfigToken(existingConfig)
	if !ok {
		return body
	}

	config := spreadObject(bodyConfig)
	config["token"] = storedToken
	normalized := spreadObject(body)
	normalized["config"] = config
	return normalized
}

// storedConfigToken 取库里 config.token 的字符串值；非字符串或缺失视为「没有」。
func storedConfigToken(raw []byte) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", false
	}
	config, ok := parsed.(map[string]any)
	if !ok {
		return "", false
	}
	token, ok := config["token"].(string)
	if !ok || token == "" {
		return "", false
	}
	return token, true
}

// marshalUpdateConfig 复刻 PUT 的 config 构造：
//
//	{...validatedConfigWithoutCursors,
//	 branches: mergeEditedBranches(existing.branches, validated.config.branches),
//	 branchCursors: existing.branchCursors?.map(...),
//	 ...(aliases?.length ? {aliases} : {})}
//
// zod 的输出已剥掉 undefined 键，而 `{branches: undefined}` 经 JSON.stringify 后
// 同样没有该键，所以 branches 只在合并结果非空时出现。
func marshalUpdateConfig(existingConfig []byte, input collectSourceInput) (string, error) {
	config := newOrderedObject()
	setOptionalString(config, "baseUrl", input.Config.BaseURL)
	setRawString(config, "owner", input.Config.Owner)
	setOptionalString(config, "repo", input.Config.Repo)
	setOptionalString(config, "token", input.Config.Token)
	setStringArray(config, "authorEmails", input.Config.AuthorEmails)

	merged, hasMerged, err := mergeEditedBranches(existingConfig, input.Config.Branches, input.Config.HasBranches)
	if err != nil {
		return "", err
	}
	if hasMerged {
		setNormalizedBranches(config, "branches", merged)
	}

	cursors, hasCursors, err := preservedBranchCursors(existingConfig)
	if err != nil {
		return "", err
	}
	if hasCursors {
		encoded, err := json.Marshal(cursors)
		if err != nil {
			return "", err
		}
		config.set("branchCursors", encoded)
	}

	if len(input.Aliases) > 0 {
		setStringArray(config, "aliases", input.Aliases)
	}

	encoded, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// patchHandler 复刻 PATCH：只更新白名单字段（enabled / status）与分支删除。
func patchHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseIntID(chi.URLParam(r, "id"))
		if !ok {
			respond.Error(w, http.StatusBadRequest, "无效的采集源ID", "INVALID_ID")
			return
		}

		body, err := jsjson.DecodeBody(r)
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		if !isInOperatorOperand(body) {
			// `'enabled' in body` 对 null / 标量抛 TypeError → 500。
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}

		existing, err := deps.Queries.GetCollectSource(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "采集源不存在", "NOT_FOUND")
			return
		}
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		if !isValidStoredConfig(existing.Config) {
			// drizzle 的 findFirst 会 JSON.parse config；损坏的存量行 → catch → 500。
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}

		object := spreadObject(body)
		var enabled *int64
		if value, present := object["enabled"]; present {
			enabled = boolPointer(jsTruthy(value))
		}

		var status *string
		if value, present := object["status"]; present {
			if text, ok := value.(string); ok && isEnumValue(text, validStatuses) {
				status = &text
			}
		}

		var configJSON *string
		if value, present := object["removeBranch"]; present {
			if branchName, ok := value.(string); ok {
				config, removalErr := removeBranch(existing.Config, branchName)
				if removalErr != nil {
					if removalErr.status == 0 {
						// 与 route.ts 的 catch 一致（例如 config 是 null / branches 里有 null）。
						logAndError(w, "更新采集源失败", "UPDATE_ERROR")
						return
					}
					respond.Error(w, removalErr.status, removalErr.message, removalErr.code)
					return
				}
				configJSON = &config
			}
		}

		record, err := deps.Queries.PatchCollectSource(r.Context(), id, enabled, status, configJSON, currentUnix())
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		item, err := toSourceJSON(record)
		if err != nil {
			logAndError(w, "更新采集源失败", "UPDATE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, item)
	}
}

// branchRemovalError 是 removeBranch 的业务错误（message + code + 状态码）。
// status == 0 表示 route.ts 的 catch 分支（500 UPDATE_ERROR）。
type branchRemovalError struct {
	message string
	code    string
	status  int
}

// removeBranch 复刻 PATCH 的分支删除分支（含三条业务错误），返回更新后的 config JSON。
// removalErr 非 nil 时另外两个返回值无意义。
//
// config 用有序对象改写：`{...config, branches: updatedBranches}` 是「branches 原位
// 替换、其余键顺序不变」，保持与 route.ts 落库的字节一致。
func removeBranch(existingConfig []byte, branchName string) (string, *branchRemovalError) {
	var parsed any
	if err := json.Unmarshal(existingConfig, &parsed); err != nil {
		return "", &branchRemovalError{}
	}
	if parsed == nil {
		// `config.branches` 在 null 上抛 TypeError → catch。
		return "", &branchRemovalError{}
	}
	config, isObject := parsed.(map[string]any)
	if !isObject {
		// 非对象 JSON（数组/字符串/标量）上读属性是 undefined → NO_BRANCHES。
		return "", &branchRemovalError{message: "采集源没有分支配置", code: "NO_BRANCHES", status: http.StatusBadRequest}
	}
	_ = config
	rawBranches, present := config["branches"]
	branches, isArray := rawBranches.([]any)
	if !present || !isArray {
		return "", &branchRemovalError{message: "采集源没有分支配置", code: "NO_BRANCHES", status: http.StatusBadRequest}
	}

	index := -1
	for i, item := range branches {
		var name string
		switch typed := item.(type) {
		case string:
			name = typed
		case map[string]any:
			name, _ = typed["name"].(string)
		case nil:
			// `(typeof b === 'string' ? b : b.name)` 在 null 上抛 TypeError → catch。
			return "", &branchRemovalError{}
		}
		if name == branchName {
			index = i
			break
		}
	}
	if index == -1 {
		return "", &branchRemovalError{message: "分支 " + branchName + " 不存在", code: "BRANCH_NOT_FOUND", status: http.StatusNotFound}
	}
	if len(branches) == 1 {
		return "", &branchRemovalError{message: "至少保留一个分支", code: "LAST_BRANCH", status: http.StatusBadRequest}
	}

	remaining := append(append([]any{}, branches[:index]...), branches[index+1:]...)
	encodedBranches, err := json.Marshal(remaining)
	if err != nil {
		return "", &branchRemovalError{}
	}
	ordered, err := parseOrderedObject(existingConfig)
	if err != nil {
		return "", &branchRemovalError{}
	}
	ordered.set("branches", encodedBranches)

	encoded, err := json.Marshal(ordered)
	if err != nil {
		return "", &branchRemovalError{}
	}
	return string(encoded), nil
}

// deleteHandler 复刻 DELETE：非法 id → 400，未找到 → 404，成功回 {success:true}。
func deleteHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseIntID(chi.URLParam(r, "id"))
		if !ok {
			respond.Error(w, http.StatusBadRequest, "无效的采集源ID", "INVALID_ID")
			return
		}
		existing, err := deps.Queries.GetCollectSource(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "采集源不存在", "NOT_FOUND")
			return
		}
		if err != nil {
			logAndError(w, "删除采集源失败", "DELETE_ERROR")
			return
		}
		if !isValidStoredConfig(existing.Config) {
			logAndError(w, "删除采集源失败", "DELETE_ERROR")
			return
		}
		if err := deps.Queries.DeleteCollectSource(r.Context(), id); err != nil {
			logAndError(w, "删除采集源失败", "DELETE_ERROR")
			return
		}
		respond.JSON(w, http.StatusOK, struct {
			Success bool `json:"success"`
		}{Success: true})
	}
}
